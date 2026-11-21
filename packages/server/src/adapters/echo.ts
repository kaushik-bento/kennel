import { randomBytes } from "node:crypto";
import type { AgentAdapter, AgentStartOptions, RunningAgent } from "./types.js";

function pause(ms: number, wake: { current: (() => void) | null }): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    wake.current = () => {
      clearTimeout(timer);
      finish();
    };
    function finish(): void {
      wake.current = null;
      resolve();
    }
  });
}

/**
 * Deterministic agent used by tests and local demos. It streams the prompt
 * back, emits one tool call, and honors interrupt and steer.
 */
export class EchoAdapter implements AgentAdapter {
  readonly kind = "echo" as const;

  constructor(private readonly delayMs: number) {}

  async start(options: AgentStartOptions): Promise<RunningAgent> {
    const nativeId = options.nativeId ?? `echo_${randomBytes(4).toString("hex")}`;
    options.onNativeId(nativeId);
    let closed = false;
    let turn: { cancelled: boolean; extras: string[] } | null = null;
    const wake = { current: null as (() => void) | null };

    const run = async (text: string): Promise<void> => {
      const local = { cancelled: false, extras: [] as string[] };
      turn = local;
      const midpoint = Math.max(1, Math.ceil(text.length / 2));
      const chunks = text.length === 0 ? [""] : [text.slice(0, midpoint), text.slice(midpoint)].filter((chunk) => chunk.length > 0);
      for (const chunk of chunks) {
        if (local.cancelled || closed) break;
        if (this.delayMs > 0) await pause(this.delayMs, wake);
        if (local.cancelled || closed) break;
        options.onEvent({ type: "message_delta", data: { text: chunk }, raw: { echo: chunk } });
      }
      if (!local.cancelled && !closed) {
        options.onEvent({
          type: "tool_call",
          data: { toolUseId: "echo-tool", name: "echo", input: { text } },
          raw: { name: "echo", input: { text } },
        });
        options.onEvent({
          type: "tool_result",
          data: { toolUseId: "echo-tool", name: "echo", output: text, isError: false },
          raw: { output: text },
        });
        for (const extra of local.extras) {
          options.onEvent({ type: "message_delta", data: { text: extra }, raw: { steer: extra } });
        }
      }
      const interrupted = local.cancelled;
      turn = null;
      if (closed) return;
      options.onEvent({
        type: "turn_completed",
        data: {
          status: interrupted ? "interrupted" : "completed",
          result: interrupted ? "" : `echo:${text}${local.extras.join("")}`,
          usage: { inputTokens: text.length, outputTokens: text.length },
        },
        raw: { status: interrupted ? "interrupted" : "completed" },
      });
    };

    return {
      nativeId,
      async deliver(text: string) {
        if (closed) throw new Error("echo agent is closed");
        void run(text);
      },
      async steer(text: string) {
        if (!turn) throw new Error("no active turn to steer");
        turn.extras.push(text);
      },
      async interrupt() {
        if (turn) turn.cancelled = true;
        wake.current?.();
      },
      async close() {
        closed = true;
        if (turn) turn.cancelled = true;
        wake.current?.();
      },
    };
  }
}
