import type { AgentKind } from "@kennel/core";
import type { AgentEvent, AgentStartOptions, RunningAgent } from "../adapters/types.js";
import { KennelError } from "../errors.js";
import { decodeFrame, encodeFrame, type RpcEvent, type RpcResponse } from "../runner/protocol.js";
import type { AgentConnection, RunnerStdio } from "./types.js";

interface Pending {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

/**
 * Speaks the kennel-runner protocol. Pending RPCs are registered before the
 * frame is written so a synchronous in-process runner cannot answer too early.
 */
export class RunnerConnection implements AgentConnection {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private handler: ((event: AgentEvent) => void) | null = null;
  private nativeHandler: ((id: string) => void) | null = null;
  private readerDone: Promise<void>;
  private released = false;

  constructor(private readonly io: RunnerStdio) {
    this.readerDone = this.read();
  }

  get sandboxId(): string | null {
    return this.io.sandboxId;
  }

  async startAgent(options: AgentStartOptions & { kind: AgentKind }): Promise<RunningAgent> {
    this.handler = options.onEvent;
    this.nativeHandler = options.onNativeId;
    const result = await this.rpc("start", {
      kind: options.kind,
      nativeId: options.nativeId,
      model: options.model,
      permissions: options.permissions,
    });
    if (typeof result.nativeId === "string") options.onNativeId(result.nativeId);
    return {
      nativeId: typeof result.nativeId === "string" ? result.nativeId : options.nativeId,
      deliver: async (text) => {
        await this.rpc("deliver", { text });
      },
      steer: async (text) => {
        await this.rpc("steer", { text });
      },
      interrupt: async () => {
        await this.rpc("interrupt", {});
      },
      close: async () => {
        await this.rpc("close", {});
      },
    };
  }

  /** Old runners do not know this method; treat them as idle. */
  async activity(): Promise<{ busy: number; processes: string[] }> {
    try {
      const result = await this.rpc("activity", {});
      const busy = Number(result.busy ?? 0);
      const processes = Array.isArray(result.processes) ? result.processes.map(String) : [];
      return { busy: Number.isFinite(busy) ? busy : 0, processes };
    } catch {
      return { busy: 0, processes: [] };
    }
  }

  async rpc(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    await this.io.write(encodeFrame({ id, method, params }));
    return response;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.failPending("runner connection closed");
    await this.io.close().catch(() => undefined);
    await this.readerDone.catch(() => undefined);
  }

  private failPending(message: string): void {
    for (const [id, waiter] of this.pending) {
      waiter.reject(new Error(message));
      this.pending.delete(id);
    }
  }

  private async read(): Promise<void> {
    try {
      for await (const line of this.io.lines()) {
        const message = decodeFrame(line);
        if (!message) continue;
        if ("method" in message && message.method === "event") {
          const params = (message as RpcEvent).params;
          this.handler?.({
            type: params.type as AgentEvent["type"],
            data: (params.data as Record<string, unknown>) ?? {},
            raw: params.raw,
          });
          continue;
        }
        if ("method" in message && message.method === "native") {
          const id = (message as RpcEvent).params.id;
          if (typeof id === "string") this.nativeHandler?.(id);
          continue;
        }
        if ("id" in message && !("method" in message)) {
          const response = message as RpcResponse;
          const waiter = this.pending.get(response.id);
          if (!waiter) continue;
          this.pending.delete(response.id);
          if (response.error) {
            const err = typeof response.error.status === "number"
              ? new KennelError(response.error.status, response.error.message)
              : new Error(response.error.message);
            waiter.reject(err);
          }
          else waiter.resolve(response.result ?? {});
        }
      }
    } finally {
      if (!this.released) this.failPending("runner stdout closed");
    }
  }
}
