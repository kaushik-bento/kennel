import { randomUUID } from "node:crypto";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { agentEnv } from "../agent-env.js";
import type { AgentAdapter, AgentEvent, AgentStartOptions, RunningAgent } from "./types.js";

export interface ClaudeQuery extends AsyncIterable<unknown> {
  interrupt(): Promise<unknown>;
  return?(value?: unknown): Promise<unknown>;
  close?(): void;
}

export interface ClaudeSdk {
  query(args: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }): ClaudeQuery;
}

interface ClaudeMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  is_error?: boolean;
  result?: string;
  usage?: unknown;
  total_cost_usd?: number;
  modelUsage?: unknown;
  num_turns?: number;
  errors?: string[];
  stop_reason?: string | null;
  terminal_reason?: string;
  message?: { content?: unknown };
  event?: {
    type?: string;
    delta?: { type?: string; text?: string };
    content_block?: { type?: string; id?: string; name?: string };
  };
}

function userMessage(text: string, steer: boolean): SDKUserMessage {
  const message: SDKUserMessage = {
    type: "user",
    uuid: randomUUID(),
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  };
  if (steer) {
    message.priority = "now";
    message.origin = { kind: "human" };
  }
  return message;
}

class PromptBridge {
  private queue: Array<SDKUserMessage | null> = [];
  private waiters: Array<(message: SDKUserMessage | null) => void> = [];

  push(message: SDKUserMessage | null): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(message);
    else this.queue.push(message);
  }

  async *iterate(): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const message = await this.next();
      if (message === null) return;
      yield message;
    }
  }

  private next(): Promise<SDKUserMessage | null> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

function contentBlocks(message: ClaudeMessage): Array<Record<string, unknown>> {
  const content = message.message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is Record<string, unknown> => typeof block === "object" && block !== null);
}

function looksAborted(message: ClaudeMessage): boolean {
  if (message.stop_reason === "aborted") return true;
  return typeof message.terminal_reason === "string" && message.terminal_reason.startsWith("aborted");
}

/**
 * Claude Code via `@anthropic-ai/claude-agent-sdk` streaming input.
 * Steer uses a user message with `priority: "now"` and `origin.kind: "human"`,
 * which the SDK documents as the mid-turn redirect. An aborted result that
 * arrives because of that steer is swallowed so the follow-up turn stays
 * attached to the same kennel prompt.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly kind = "claude" as const;

  constructor(private readonly sdk?: ClaudeSdk) {}

  async start(options: AgentStartOptions): Promise<RunningAgent> {
    const sdk = this.sdk ?? (await loadClaudeSdk());
    const bridge = new PromptBridge();
    const queryOptions: Options = {
      cwd: options.cwd,
      includePartialMessages: true,
      settingSources: ["project"],
      // The SDK replaces the process environment, so pass a copy with triage secrets removed.
      env: agentEnv(process.env, { strip: options.stripEnv, extra: options.extraEnv }),
      stderr: (line) => {
        options.onEvent({ type: "error", data: { message: line, stream: "stderr" }, raw: line });
      },
    };
    if (options.nativeId) queryOptions.resume = options.nativeId;
    if (options.model) queryOptions.model = options.model;
    if (options.permissions.permissionMode) queryOptions.permissionMode = options.permissions.permissionMode;
    if (options.permissions.permissionMode === "bypassPermissions") {
      queryOptions.allowDangerouslySkipPermissions = true;
    }
    if (options.permissions.allowedTools) queryOptions.allowedTools = options.permissions.allowedTools;
    if (options.permissions.disallowedTools) queryOptions.disallowedTools = options.permissions.disallowedTools;
    if (options.testingAddendum) {
      queryOptions.systemPrompt = { type: "preset", preset: "claude_code", append: options.testingAddendum };
    }

    const query = sdk.query({ prompt: bridge.iterate(), options: queryOptions });
    const state = { interruptRequested: false, steerSuppress: 0, sawResult: false, closed: false };
    void pumpClaude(query, options, state);

    return {
      nativeId: options.nativeId,
      async deliver(text: string) {
        bridge.push(userMessage(text, false));
      },
      async steer(text: string) {
        state.steerSuppress += 1;
        bridge.push(userMessage(text, true));
      },
      async interrupt() {
        state.interruptRequested = true;
        await query.interrupt();
      },
      async close() {
        state.closed = true;
        bridge.push(null);
        try {
          await query.return?.();
        } catch {
          // The process may already be gone.
        }
        query.close?.();
      },
    };
  }
}

async function pumpClaude(
  query: ClaudeQuery,
  options: AgentStartOptions,
  state: { interruptRequested: boolean; steerSuppress: number; sawResult: boolean; closed: boolean },
): Promise<void> {
  let nativeId = options.nativeId;
  try {
    for await (const item of query) {
      const message = item as ClaudeMessage;
      if (message.session_id && message.session_id !== nativeId) {
        nativeId = message.session_id;
        options.onNativeId(message.session_id);
      }
      for (const event of normalizeClaude(message, state)) {
        if (event.type === "turn_completed") state.sawResult = true;
        options.onEvent(event);
      }
    }
  } catch (err) {
    if (state.sawResult) return;
    const message = err instanceof Error ? err.message : String(err);
    options.onEvent({ type: "error", data: { message, fatal: true }, raw: { message } });
    options.onEvent({
      type: "turn_completed",
      data: { status: "failed", error: message, processExited: true },
      raw: { message },
    });
  }
}

function normalizeClaude(
  message: ClaudeMessage,
  state: { interruptRequested: boolean; steerSuppress: number },
): AgentEvent[] {
  if (message.type === "stream_event") {
    const delta = message.event?.delta;
    if (message.event?.type === "content_block_delta" && delta?.type === "text_delta" && delta.text) {
      return [{ type: "message_delta", data: { text: delta.text }, raw: message }];
    }
    return [];
  }
  if (message.type === "assistant") {
    const events: AgentEvent[] = [];
    for (const block of contentBlocks(message)) {
      if (block.type === "tool_use") {
        events.push({
          type: "tool_call",
          data: {
            toolUseId: String(block.id ?? ""),
            name: String(block.name ?? "tool"),
            input: block.input ?? {},
          },
          raw: message,
        });
      }
    }
    return events;
  }
  if (message.type === "user") {
    const events: AgentEvent[] = [];
    for (const block of contentBlocks(message)) {
      if (block.type === "tool_result") {
        events.push({
          type: "tool_result",
          data: {
            toolUseId: String(block.tool_use_id ?? ""),
            output: block.content ?? "",
            isError: Boolean(block.is_error),
          },
          raw: message,
        });
      }
    }
    return events;
  }
  if (message.type === "result") {
    const aborted = looksAborted(message) || state.interruptRequested;
    if (state.steerSuppress > 0 && aborted && !state.interruptRequested) {
      state.steerSuppress -= 1;
      return [];
    }
    state.steerSuppress = 0;
    const failed = Boolean(message.is_error) || (message.subtype !== undefined && message.subtype !== "success");
    const status = state.interruptRequested || aborted ? "interrupted" : failed ? "failed" : "completed";
    state.interruptRequested = false;
    return [
      {
        type: "turn_completed",
        data: {
          status,
          result: message.result,
          usage: message.usage,
          costUsd: message.total_cost_usd,
          modelUsage: message.modelUsage,
          numTurns: message.num_turns,
          subtype: message.subtype,
          errors: message.errors,
        },
        raw: message,
      },
    ];
  }
  return [];
}

async function loadClaudeSdk(): Promise<ClaudeSdk> {
  const mod = (await import("@anthropic-ai/claude-agent-sdk")) as unknown as ClaudeSdk;
  return { query: mod.query.bind(mod) };
}
