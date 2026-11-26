import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { SandboxMode } from "@kennel/core";
import { agentEnv } from "../agent-env.js";
import type { AgentAdapter, AgentEvent, AgentStartOptions, RunningAgent } from "./types.js";

type SpawnEnv = Record<string, string>;

export interface CodexProcess {
  stdin: { write(chunk: string): boolean; end(): void };
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(): void;
  on(event: "exit", listener: (code: number | null) => void): void;
}

type Json = Record<string, unknown>;

interface Pending {
  resolve: (message: Json) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const TOOL_ITEM_TYPES = new Set(["commandExecution", "mcpToolCall", "dynamicToolCall", "fileChange", "webSearch"]);

function sandboxPolicy(mode: SandboxMode, cwd: string, networkAccess: boolean | undefined): Json {
  if (mode === "read-only") {
    return { type: "readOnly", networkAccess: networkAccess ?? false };
  }
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  return { type: "workspaceWrite", writableRoots: [cwd], networkAccess: networkAccess ?? true };
}

function textInput(text: string): Json[] {
  return [{ type: "text", text }];
}

/**
 * Codex via `codex app-server` over stdio.
 * Messages omit the `jsonrpc` field, matching the current app-server wire format.
 * Method names and params follow the v2 protocol:
 * initialize, initialized, thread/start, thread/resume, turn/start, turn/steer, turn/interrupt.
 */
export class CodexAdapter implements AgentAdapter {
  readonly kind = "codex" as const;

  constructor(
    private readonly bin = "codex",
    private readonly spawnProcess: (bin: string, cwd: string, env?: SpawnEnv) => CodexProcess = defaultSpawn,
  ) {}

  async start(options: AgentStartOptions): Promise<RunningAgent> {
    const child = this.spawnProcess(
      this.bin,
      options.cwd,
      agentEnv(process.env, { strip: options.stripEnv, extra: options.extraEnv }),
    );
    const client = new CodexClient(child, options);
    await client.handshake();
    const threadId = options.nativeId
      ? await client.resumeThread(options.nativeId)
      : await client.startThread();
    options.onNativeId(threadId);
    return {
      nativeId: threadId,
      deliver: (text) => client.startTurn(text),
      steer: (text) => client.steer(text),
      interrupt: () => client.interrupt(),
      close: () => client.close(),
    };
  }
}

class CodexClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private threadId: string | null = null;
  private turnId: string | null = null;
  private stderr = "";
  private closed = false;
  private lastUsage: unknown;

  constructor(
    private readonly child: CodexProcess,
    private readonly options: AgentStartOptions,
  ) {
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.onLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    child.on("exit", (code) => {
      if (this.closed) return;
      const message = `codex app-server exited (${code ?? "signal"})${this.stderr ? `: ${this.stderr.trim()}` : ""}`;
      this.failPending(message);
      this.options.onEvent({ type: "error", data: { message, fatal: true }, raw: { code, stderr: this.stderr } });
      if (this.turnId) {
        this.options.onEvent({
          type: "turn_completed",
          data: { status: "failed", error: message, processExited: true },
          raw: { code },
        });
        this.turnId = null;
      }
    });
  }

  async handshake(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "kennel", title: "kennel", version: "0.1.0" },
    });
    this.notify("initialized", {});
  }

  async startThread(): Promise<string> {
    const result = await this.request("thread/start", {
      cwd: this.options.cwd,
      model: this.options.model,
      approvalPolicy: this.options.permissions.approvalPolicy ?? "never",
      sandbox: this.options.permissions.sandbox ?? "workspace-write",
      serviceName: "kennel",
      ...(this.options.testingAddendum ? { developerInstructions: this.options.testingAddendum } : {}),
    });
    const thread = result.thread as { id?: string } | undefined;
    if (!thread?.id) throw new Error("thread/start did not return thread.id");
    this.threadId = thread.id;
    return thread.id;
  }

  async resumeThread(threadId: string): Promise<string> {
    const result = await this.request("thread/resume", {
      threadId,
      cwd: this.options.cwd,
      model: this.options.model,
      approvalPolicy: this.options.permissions.approvalPolicy ?? "never",
      sandbox: this.options.permissions.sandbox ?? "workspace-write",
      // Documented on the current app-server page. Older servers ignore unknown fields.
      excludeTurns: true,
    });
    const thread = result.thread as { id?: string } | undefined;
    this.threadId = thread?.id ?? threadId;
    return this.threadId;
  }

  async startTurn(text: string): Promise<void> {
    const permissions = this.options.permissions;
    const sandbox = permissions.sandbox ?? "workspace-write";
    const result = await this.request("turn/start", {
      threadId: this.requiredThread(),
      input: textInput(text),
      cwd: this.options.cwd,
      model: this.options.model,
      approvalPolicy: permissions.approvalPolicy ?? "never",
      sandboxPolicy: sandboxPolicy(sandbox, this.options.cwd, permissions.networkAccess),
    });
    const turn = result.turn as { id?: string } | undefined;
    if (turn?.id) this.turnId = turn.id;
  }

  async steer(text: string): Promise<void> {
    if (!this.turnId) throw new Error("no active Codex turn to steer");
    await this.request("turn/steer", {
      threadId: this.requiredThread(),
      expectedTurnId: this.turnId,
      input: textInput(text),
    });
  }

  async interrupt(): Promise<void> {
    if (!this.turnId) return;
    const turnId = this.turnId;
    await this.request("turn/interrupt", { threadId: this.requiredThread(), turnId });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failPending("codex client closed");
    this.child.stdin.end();
    this.child.kill();
  }

  private failPending(message: string): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(message));
      this.pending.delete(id);
    }
  }

  private requiredThread(): string {
    if (!this.threadId) throw new Error("codex thread is not started");
    return this.threadId;
  }

  private request(method: string, params: Json): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex ${method} timed out`));
      }, 60_000);
      // Register before writing. An in-process fake answers synchronously, and the
      // response would otherwise arrive before this map has the id.
      this.pending.set(id, { resolve, reject, timer });
      this.write({ method, id, params: dropUndefined(params) });
    });
  }

  private notify(method: string, params: Json): void {
    this.write({ method, params });
  }

  private write(message: Json): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: Json;
    try {
      message = JSON.parse(trimmed) as Json;
    } catch {
      return;
    }
    if (message.id !== undefined && message.method === undefined) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(Number(message.id));
      if (message.error) {
        const error = message.error as { message?: string };
        pending.reject(new Error(error.message ?? "codex request failed"));
      } else {
        pending.resolve((message.result as Json | undefined) ?? {});
      }
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") {
      this.answerServerRequest(message);
      return;
    }
    if (typeof message.method === "string") this.onNotification(message.method, (message.params as Json) ?? {});
  }

  private answerServerRequest(message: Json): void {
    const method = String(message.method);
    const approval = this.options.permissions.approvalPolicy ?? "never";
    const decision = approval === "never" ? "accept" : "decline";
    let result: Json = { decision };
    if (method === "item/permissions/requestApproval") {
      const params = (message.params as Json | undefined) ?? {};
      result = approval === "never" ? { permissions: params.permissions ?? [] } : { permissions: [] };
    }
    this.write({ id: message.id, result });
  }

  private onNotification(method: string, params: Json): void {
    for (const event of normalizeCodex(method, params, this)) {
      this.options.onEvent(event);
    }
  }

  setTurnId(id: string | null): void {
    this.turnId = id;
  }

  setUsage(usage: unknown): void {
    this.lastUsage = usage;
  }

  takeUsage(): unknown {
    const usage = this.lastUsage;
    this.lastUsage = undefined;
    return usage;
  }
}

function normalizeCodex(method: string, params: Json, client: CodexClient): AgentEvent[] {
  if (method === "turn/started") {
    const turn = params.turn as { id?: string } | undefined;
    if (turn?.id) client.setTurnId(turn.id);
    return [];
  }
  if (method === "item/agentMessage/delta") {
    return [{ type: "message_delta", data: { text: String(params.delta ?? ""), messageId: params.itemId }, raw: params }];
  }
  if (method === "item/commandExecution/outputDelta") {
    return [
      {
        type: "message_delta",
        data: { text: String(params.delta ?? ""), toolUseId: params.itemId },
        raw: params,
      },
    ];
  }
  if (method === "thread/tokenUsage/updated") {
    client.setUsage(params.tokenUsage);
    return [];
  }
  if (method === "item/started" || method === "item/completed") {
    const item = params.item as Json | undefined;
    if (!item || typeof item.type !== "string" || !TOOL_ITEM_TYPES.has(item.type)) return [];
    if (method === "item/started") {
      return [
        {
          type: "tool_call",
          data: {
            toolUseId: String(item.id ?? ""),
            name: toolName(item),
            input: toolInput(item),
          },
          raw: params,
        },
      ];
    }
    const status = String(item.status ?? "");
    return [
      {
        type: "tool_result",
        data: {
          toolUseId: String(item.id ?? ""),
          name: toolName(item),
          output: item.aggregatedOutput ?? item.result ?? item.changes ?? item.error ?? status,
          isError: status === "failed" || status === "declined" || Boolean(item.error),
        },
        raw: params,
      },
    ];
  }
  if (method === "turn/completed") {
    const turn = (params.turn as Json | undefined) ?? {};
    const status = String(turn.status ?? "completed");
    const error = turn.error as { message?: string } | null | undefined;
    client.setTurnId(null);
    return [
      {
        type: "turn_completed",
        data: {
          status: status === "interrupted" || status === "failed" ? status : "completed",
          usage: client.takeUsage(),
          error: error?.message,
          result: status === "completed" ? undefined : error?.message,
        },
        raw: params,
      },
    ];
  }
  if (method === "error") {
    const error = (params.error as { message?: string } | undefined) ?? params;
    const message = typeof error === "object" && error && "message" in error ? String(error.message) : "codex error";
    return [{ type: "error", data: { message }, raw: params }];
  }
  return [];
}

function toolName(item: Json): string {
  if (typeof item.tool === "string") return item.tool;
  if (typeof item.command === "string") return "command";
  return String(item.type);
}

function toolInput(item: Json): unknown {
  if (item.command !== undefined) return { command: item.command, cwd: item.cwd };
  if (item.arguments !== undefined) return item.arguments;
  if (item.query !== undefined) return { query: item.query };
  if (item.changes !== undefined) return item.changes;
  return {};
}

function dropUndefined(params: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function defaultSpawn(bin: string, cwd: string, env?: SpawnEnv): CodexProcess {
  const child: ChildProcessWithoutNullStreams = spawn(bin, ["app-server"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: env ?? agentEnv(),
  });
  return child;
}
