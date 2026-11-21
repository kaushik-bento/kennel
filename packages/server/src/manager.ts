import {
  branchName,
  createId,
  planAfterTurn,
  planBootRecovery,
  planPrompt,
  type CreateSessionInput,
  type EventPage,
  type FinishInput,
  type FinishResult,
  type KennelApi,
  type KennelEvent,
  type PromptResult,
  type SendPromptInput,
  type SessionState,
  type SessionView,
} from "@kennel/core";
import type { AgentEvent, RunningAgent } from "./adapters/types.js";
import { Actor } from "./actor.js";
import { EventBus } from "./bus.js";
import type { KennelConfig } from "./config.js";
import { KennelDb, type PromptRow, type SessionRow } from "./db.js";
import { KennelError } from "./errors.js";
import type { AgentConnection, SandboxBackend } from "./sandbox/index.js";

interface LiveSession {
  agent: RunningAgent;
  conn: AgentConnection;
  turnActive: boolean;
  currentPromptId: string | null;
  stopRequested: boolean;
  exited: boolean;
}

export class SessionManager implements KennelApi {
  private readonly actor = new Actor();
  private readonly bus = new EventBus();
  private readonly live = new Map<string, LiveSession>();

  private readonly idleTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly db: KennelDb,
    private readonly backend: SandboxBackend,
    private readonly config: KennelConfig,
  ) {}

  recover(): void {
    for (const session of this.db.listActive()) {
      const plan = planBootRecovery(session.state);
      if (!plan.requeueRunningPrompt) continue;
      this.db.requeueRunning(session.id);
      this.db.setState(session.id, plan.state, plan.error);
      this.record(session.id, "status", { state: plan.state, detail: plan.error }, undefined);
    }
    const queued = this.db.listActive().filter((session) => session.state === "queued");
    if (queued.length === 0) return;
    void this.actor.run(async () => {
      await this.pumpMany(queued.map((session) => session.id));
    });
  }

  async shutdown(): Promise<void> {
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    const agents = [...this.live.values()];
    this.live.clear();
    await Promise.all(agents.map((entry) => this.releaseLive(entry)));
  }

  createSession(input: CreateSessionInput): Promise<SessionView> {
    return this.actor.run(async () => {
      if (input.agent !== "claude" && input.agent !== "codex" && input.agent !== "echo") {
        throw new KennelError(400, `unknown agent: ${input.agent}`);
      }
      const id = createId();
      const branch = branchName(id);
      const prepared = await this.backend.provision({
        sessionId: id,
        repo: input.repo,
        baseBranch: input.baseBranch,
        branch,
      });
      const now = new Date().toISOString();
      const row: SessionRow = {
        id,
        agent: input.agent,
        repo: input.repo,
        baseBranch: input.baseBranch,
        branch,
        worktreePath: prepared.worktreePath,
        sourcePath: prepared.sourcePath,
        backend: this.backend.kind,
        sandboxId: prepared.sandboxId,
        volumeName: prepared.volumeName,
        state: "idle",
        nativeSessionId: null,
        model: input.model ?? null,
        permissions: input.permissions ?? {},
        error: null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      try {
        this.db.insertSession(row);
      } catch (err) {
        await this.backend.destroy(row, true).catch(() => undefined);
        throw err;
      }
      this.record(id, "status", { state: "idle", queueDepth: 0 }, undefined);
      return this.view(row);
    });
  }

  listSessions(): Promise<SessionView[]> {
    return Promise.resolve(this.db.listSessions().map((row) => this.view(row)));
  }

  getSession(id: string): Promise<SessionView> {
    return Promise.resolve(this.view(this.require(id)));
  }

  sendPrompt(id: string, input: SendPromptInput): Promise<PromptResult> {
    return this.actor.run(async () => {
      const session = this.require(id);
      const live = this.live.get(id);
      this.cancelIdleRelease(id);
      const plan = planPrompt({
        state: session.state,
        mode: input.mode,
        turnActive: Boolean(live?.turnActive),
        runningSessions: this.db.countRunning(),
        maxConcurrent: this.config.maxConcurrent,
      });
      if (plan.type === "reject") throw new KennelError(409, plan.message);
      if (plan.type === "steer") {
        if (!live) throw new KennelError(409, "no active turn to steer");
        const prompt = this.insertPrompt(id, input.text, "steer", "done");
        await live.agent.steer(input.text);
        this.record(id, "status", { state: "running", queueDepth: this.db.queueDepth(id), steer: input.text, promptId: prompt.id }, undefined);
        return {
          promptId: prompt.id,
          delivery: "steered",
          state: "running",
          queueDepth: this.db.queueDepth(id),
        };
      }
      const prompt = this.insertPrompt(id, input.text, input.mode, "queued");
      if (plan.type === "enqueue") {
        if (session.state !== plan.state) this.db.setState(id, plan.state, null);
        this.record(id, "status", { state: plan.state, queueDepth: this.db.queueDepth(id), promptId: prompt.id }, undefined);
        return {
          promptId: prompt.id,
          delivery: "queued",
          state: plan.state,
          queueDepth: this.db.queueDepth(id),
        };
      }
      await this.pumpMany([id]);
      const updated = this.require(id);
      return {
        promptId: prompt.id,
        delivery: updated.state === "running" ? "started" : "queued",
        state: updated.state,
        queueDepth: this.db.queueDepth(id),
      };
    });
  }

  getEvents(id: string, opts: { after?: number; waitMs?: number }): Promise<EventPage> {
    this.require(id);
    const after = opts.after ?? 0;
    const waitMs = Math.min(Math.max(opts.waitMs ?? 0, 0), 60_000);
    return this.readEvents(id, after, waitMs);
  }

  async *streamEvents(id: string, after: number, signal: AbortSignal): AsyncGenerator<KennelEvent> {
    this.require(id);
    let cursor = after;
    while (!signal.aborted) {
      const events = this.db.eventsAfter(id, cursor, 200);
      if (events.length > 0) {
        for (const event of events) {
          cursor = event.id;
          yield event;
        }
        continue;
      }
      await this.bus.wait(id, cursor, 15_000, signal);
    }
  }

  interrupt(id: string): Promise<SessionView> {
    return this.actor.run(async () => {
      const session = this.require(id);
      const live = this.live.get(id);
      if (live?.turnActive) await live.agent.interrupt();
      return this.view(this.require(session.id));
    });
  }

  stop(id: string): Promise<SessionView> {
    return this.actor.run(async () => {
      this.require(id);
      this.cancelIdleRelease(id);
      this.db.cancelQueued(id);
      const live = this.live.get(id);
      if (live?.turnActive) {
        live.stopRequested = true;
        this.db.setState(id, "stopped", null);
        this.record(id, "status", { state: "stopped", queueDepth: 0 }, undefined);
        await live.agent.interrupt();
        return this.view(this.require(id));
      }
      await this.release(id, "stopped", null);
      return this.view(this.require(id));
    });
  }

  resume(id: string): Promise<SessionView> {
    return this.actor.run(async () => {
      this.cancelIdleRelease(id);
      const session = this.require(id);
      const live = this.live.get(id);
      if (live && !live.exited && live.turnActive) return this.view(session);
      if (live?.exited) this.live.delete(id);
      if (!live || live.exited) this.db.requeueRunning(id);
      const queued = this.db.queueDepth(id);
      const next: SessionState = queued > 0 ? "queued" : "idle";
      this.db.setState(id, next, null);
      this.record(id, "status", { state: next, queueDepth: queued, detail: "resumed" }, undefined);
      await this.pumpMany([id]);
      return this.view(this.require(id));
    });
  }

  finishSession(id: string, input: FinishInput): Promise<FinishResult> {
    return this.actor.run(async () => {
      const session = this.require(id);
      if (session.state === "running" || session.state === "queued") {
        throw new KennelError(409, "session still has work in progress; wait, interrupt, or stop before finish");
      }
      this.cancelIdleRelease(id);
      const live = this.live.get(id);
      if (live) await this.release(id, session.state, session.error);
      const result = await this.backend.finish(this.require(id), {
        commitMessage: input.commitMessage,
        openPr: input.openPr !== false,
      });
      this.record(id, "status", { state: session.state, finish: result }, undefined);
      return { ...result, branch: session.branch };
    });
  }

  closeSession(id: string, opts?: { cleanup?: boolean }): Promise<{ deleted: true; cleanup: boolean }> {
    return this.actor.run(async () => {
      const session = this.require(id);
      const cleanup = opts?.cleanup !== false;
      this.cancelIdleRelease(id);
      this.db.cancelQueued(id);
      const live = this.live.get(id);
      if (live) {
        live.stopRequested = true;
        this.live.delete(id);
        await this.releaseLive(live);
      }
      this.db.requeueRunning(id);
      this.db.cancelQueued(id);
      this.db.markDeleted(id);
      await this.backend.destroy(session, cleanup).catch(() => undefined);
      return { deleted: true, cleanup };
    });
  }

  private async readEvents(id: string, after: number, waitMs: number): Promise<EventPage> {
    let events = this.db.eventsAfter(id, after, 200);
    if (events.length === 0 && waitMs > 0) {
      await this.bus.wait(id, after, waitMs);
      events = this.db.eventsAfter(id, after, 200);
    }
    const cursor = events.at(-1)?.id ?? after;
    return { events, cursor };
  }

  private require(id: string): SessionRow {
    const session = this.db.getSession(id);
    if (!session || session.deletedAt) throw new KennelError(404, `session not found: ${id}`);
    return session;
  }

  private view(row: SessionRow): SessionView {
    return {
      id: row.id,
      agent: row.agent,
      repo: row.repo,
      baseBranch: row.baseBranch,
      branch: row.branch,
      worktreePath: row.worktreePath,
      state: row.state,
      queueDepth: this.db.queueDepth(row.id),
      nativeSessionId: row.nativeSessionId,
      model: row.model,
      permissions: row.permissions,
      error: row.error,
      backend: row.backend,
      sandboxId: row.sandboxId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private insertPrompt(sessionId: string, text: string, mode: PromptRow["mode"], status: PromptRow["status"]): PromptRow {
    const prompt: PromptRow = {
      id: createId(),
      sessionId,
      text,
      mode,
      status,
      position: this.db.nextPosition(sessionId),
    };
    this.db.insertPrompt(prompt);
    return prompt;
  }

  private record(sessionId: string, type: KennelEvent["type"], data: Record<string, unknown>, raw: unknown): void {
    const event = this.db.appendEvent({ sessionId, type, data, raw });
    this.bus.publish(event);
  }

  private async pumpMany(sessionIds: string[]): Promise<void> {
    const jobs: Array<() => Promise<void>> = [];
    for (const sessionId of sessionIds) {
      const job = this.preparePump(sessionId);
      if (job) jobs.push(job);
    }
    const waiting = this.db.listActive().filter((session) => session.state === "queued").map((session) => session.id);
    for (const sessionId of waiting) {
      if (sessionIds.includes(sessionId)) continue;
      const job = this.preparePump(sessionId);
      if (job) jobs.push(job);
    }
    for (const job of jobs) await job();
  }

  /** Mark the next prompt running and return the deliver call, or null when nothing should start. */
  private preparePump(sessionId: string): (() => Promise<void>) | null {
    const session = this.db.getSession(sessionId);
    if (!session || session.deletedAt) return null;
    if (session.state === "stopped" || session.state === "error") return null;
    const live = this.live.get(sessionId);
    if (live?.turnActive || live?.stopRequested) return null;
    const next = this.db.nextQueuedPrompt(sessionId);
    if (!next) {
      if (session.state !== "idle") {
        this.db.setState(sessionId, "idle", null);
        this.record(sessionId, "status", { state: "idle", queueDepth: 0 }, undefined);
      }
      return null;
    }
    const running = this.db.countRunning();
    const holdsSlot = session.state === "running";
    const others = holdsSlot ? Math.max(0, running - 1) : running;
    if (others >= this.config.maxConcurrent) {
      if (session.state !== "queued") {
        this.db.setState(sessionId, "queued", null);
        this.record(sessionId, "status", { state: "queued", queueDepth: this.db.queueDepth(sessionId) }, undefined);
      }
      return null;
    }
    this.db.markPromptRunning(next.id);
    if (session.state !== "running") {
      this.db.setState(sessionId, "running", null);
      this.record(sessionId, "status", { state: "running", queueDepth: this.db.queueDepth(sessionId), promptId: next.id }, undefined);
    }
    return async () => {
      await this.deliver(sessionId, next.id, next.text);
    };
  }

  private async deliver(sessionId: string, promptId: string, text: string): Promise<void> {
    const session = this.require(sessionId);
    let live = this.live.get(sessionId);
    if (!live || live.exited) {
      const placeholder: LiveSession = {
        agent: {
          nativeId: session.nativeSessionId,
          deliver: async () => undefined,
          steer: async () => undefined,
          interrupt: async () => undefined,
          close: async () => undefined,
        },
        conn: { sandboxId: null, startAgent: async () => placeholder.agent, release: async () => undefined },
        turnActive: true,
        currentPromptId: promptId,
        stopRequested: false,
        exited: false,
      };
      this.live.set(sessionId, placeholder);
      try {
        const conn = await this.backend.acquire(session);
        placeholder.conn = conn;
        if (conn.sandboxId) this.db.setSandboxId(sessionId, conn.sandboxId);
        const agent = await conn.startAgent({
          kind: session.agent,
          cwd: session.worktreePath,
          nativeId: session.nativeSessionId,
          ...(session.model ? { model: session.model } : {}),
          permissions: session.permissions,
          onEvent: (event) => {
            this.actor.run(() => this.onAgentEvent(sessionId, event)).catch(() => undefined);
          },
          onNativeId: (nativeId) => {
            this.actor.run(() => {
              this.db.setNativeSessionId(sessionId, nativeId);
            }).catch(() => undefined);
          },
        });
        placeholder.agent = agent;
        live = placeholder;
      } catch (err) {
        this.live.delete(sessionId);
        const message = err instanceof Error ? err.message : String(err);
        this.db.finishPrompt(promptId, "error");
        this.db.setState(sessionId, "error", message);
        this.record(sessionId, "error", { message, fatal: true }, undefined);
        this.record(sessionId, "status", { state: "error", detail: message }, undefined);
        return;
      }
    }
    if (live.exited || (live.currentPromptId !== promptId && !live.turnActive)) {
      live.turnActive = true;
      live.currentPromptId = promptId;
    }
    live.turnActive = true;
    live.currentPromptId = promptId;
    try {
      await live.agent.deliver(text);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      live.turnActive = false;
      live.currentPromptId = null;
      this.db.finishPrompt(promptId, "error");
      this.db.setState(sessionId, "error", message);
      this.record(sessionId, "error", { message, fatal: true }, undefined);
      this.record(sessionId, "turn_completed", { status: "failed", promptId, error: message }, undefined);
      this.record(sessionId, "status", { state: "error", detail: message }, undefined);
    }
  }

  private onAgentEvent(sessionId: string, event: AgentEvent): void {
    const session = this.db.getSession(sessionId);
    if (!session || session.deletedAt) return;
    const live = this.live.get(sessionId);
    if (event.type === "turn_completed") {
      const promptId = live?.currentPromptId ?? null;
      const status = String(event.data.status ?? "completed");
      if (promptId) {
        const promptStatus = status === "failed" ? "error" : status === "interrupted" ? "interrupted" : "done";
        this.db.finishPrompt(promptId, promptStatus);
      }
      if (live) {
        live.turnActive = false;
        live.currentPromptId = null;
      }
      this.record(sessionId, "turn_completed", { ...event.data, promptId }, event.raw);
      const processExited = Boolean(event.data.processExited);
      if (processExited) {
        if (live) {
          live.exited = true;
          const conn = live.conn;
          this.live.delete(sessionId);
          void conn.release().catch(() => undefined);
        }
        const message = String(event.data.error ?? "agent process exited");
        this.db.setState(sessionId, "error", message);
        this.record(sessionId, "status", { state: "error", detail: message }, undefined);
        return;
      }
      if (live?.stopRequested) {
        void this.release(sessionId, "stopped", null).then(() => this.pumpMany([]));
        return;
      }
      const queuedCount = this.db.queueDepth(sessionId);
      const plan = planAfterTurn({ stopRequested: false, queuedCount });
      if (!plan.startNext) {
        this.db.setState(sessionId, plan.state, null);
        this.record(sessionId, "status", { state: plan.state, queueDepth: queuedCount }, undefined);
        if (plan.state === "idle") this.scheduleIdleRelease(sessionId);
        void this.pumpMany([]);
        return;
      }
      void this.pumpMany([sessionId]);
      return;
    }
    if (event.type === "error" && event.data.fatal && !live?.turnActive) {
      if (live) live.exited = true;
      this.live.delete(sessionId);
      const message = String(event.data.message ?? "agent process exited");
      this.db.setState(sessionId, "error", message);
      this.record(sessionId, "error", event.data, event.raw);
      this.record(sessionId, "status", { state: "error", detail: message }, undefined);
      return;
    }
    this.record(sessionId, event.type, event.data, event.raw);
  }

  private async release(sessionId: string, state: SessionState, error: string | null): Promise<void> {
    this.cancelIdleRelease(sessionId);
    const live = this.live.get(sessionId);
    this.live.delete(sessionId);
    if (live) await this.releaseLive(live);
    this.db.setSandboxId(sessionId, null);
    this.db.setState(sessionId, state, error);
    this.record(sessionId, "status", { state, queueDepth: this.db.queueDepth(sessionId), detail: error }, undefined);
  }

  private async releaseLive(live: LiveSession): Promise<void> {
    await live.agent.close().catch(() => undefined);
    await live.conn.release().catch(() => undefined);
  }

  private scheduleIdleRelease(sessionId: string): void {
    this.cancelIdleRelease(sessionId);
    const run = () => {
      this.idleTimers.delete(sessionId);
      void this.actor.run(async () => {
        const session = this.db.getSession(sessionId);
        const live = this.live.get(sessionId);
        if (!session || session.deletedAt || session.state !== "idle" || live?.turnActive) return;
        if (!live) return;
        this.live.delete(sessionId);
        await this.releaseLive(live);
        this.db.setSandboxId(sessionId, null);
      });
    };
    if (this.config.sandboxIdleMs <= 0) {
      run();
      return;
    }
    this.idleTimers.set(sessionId, setTimeout(run, this.config.sandboxIdleMs));
  }

  private cancelIdleRelease(sessionId: string): void {
    const timer = this.idleTimers.get(sessionId);
    if (!timer) return;
    clearTimeout(timer);
    this.idleTimers.delete(sessionId);
  }
}
