import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter, type ClaudeQuery, type ClaudeSdk } from "../src/adapters/claude.js";
import type { AgentEvent } from "../src/adapters/types.js";

class FakeQuery implements ClaudeQuery {
  readonly messages: SDKUserMessage[] = [];
  interrupted = false;
  private pull: (() => void) | null = null;
  private closed = false;

  constructor(private readonly script: (query: FakeQuery) => AsyncGenerator<unknown>) {}

  interrupt(): Promise<void> {
    this.interrupted = true;
    return Promise.resolve();
  }

  async return(): Promise<void> {
    this.closed = true;
    this.pull?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    yield* this.script(this);
  }

  async nextMessage(): Promise<SDKUserMessage | null> {
    while (this.messages.length === 0 && !this.closed) {
      await new Promise<void>((resolve) => {
        this.pull = resolve;
      });
    }
    return this.messages.shift() ?? null;
  }

  note(message: SDKUserMessage): void {
    this.messages.push(message);
    this.pull?.();
    this.pull = null;
  }
}

function sdk(script: (query: FakeQuery) => AsyncGenerator<unknown>, seen: { options?: Options } = {}): ClaudeSdk {
  return {
    query({ prompt, options }) {
      seen.options = options;
      const query = new FakeQuery(script);
      void (async () => {
        for await (const message of prompt) query.note(message);
      })();
      return query;
    },
  };
}

describe("claude adapter", () => {
  it("normalizes stream events, tool calls, and the result, and resumes a session id", async () => {
    const seen: { options?: Options } = {};
    const events: AgentEvent[] = [];
    let native = "";
    const adapter = new ClaudeAdapter(
      sdk(async function* (query) {
        yield { type: "system", subtype: "init", session_id: "sess_123" };
        const message = await query.nextMessage();
        assert.equal(message?.message.content, "fix the tests");
        yield {
          type: "stream_event",
          session_id: "sess_123",
          event: { type: "content_block_delta", delta: { type: "text_delta", text: "ok" } },
        };
        yield {
          type: "assistant",
          session_id: "sess_123",
          message: { content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { path: "a.ts" } }] },
        };
        yield {
          type: "user",
          session_id: "sess_123",
          message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "file" }] },
          parent_tool_use_id: null,
        };
        yield {
          type: "result",
          subtype: "success",
          session_id: "sess_123",
          is_error: false,
          result: "done",
          usage: { input_tokens: 3, output_tokens: 4 },
          total_cost_usd: 0.01,
        };
      }, seen),
    );
    const running = await adapter.start({
      cwd: "/tmp/work",
      nativeId: "sess_old",
      model: "claude-sonnet-5-5",
      permissions: { permissionMode: "acceptEdits", allowedTools: ["Read"], disallowedTools: ["Bash"] },
      onEvent: (event) => events.push(event),
      onNativeId: (id) => {
        native = id;
      },
    });
    await running.deliver("fix the tests");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(native, "sess_123");
    assert.equal(seen.options?.resume, "sess_old");
    assert.equal(seen.options?.model, "claude-sonnet-5-5");
    assert.equal(seen.options?.permissionMode, "acceptEdits");
    assert.equal(seen.options?.includePartialMessages, true);
    assert.deepEqual(seen.options?.allowedTools, ["Read"]);
    assert.equal(events.find((event) => event.type === "message_delta")?.data.text, "ok");
    assert.equal(events.find((event) => event.type === "tool_call")?.data.name, "Read");
    assert.equal(events.find((event) => event.type === "tool_result")?.data.output, "file");
    const completed = events.find((event) => event.type === "turn_completed");
    assert.equal(completed?.data.status, "completed");
    assert.equal(completed?.data.costUsd, 0.01);
    await running.close();
  });

  it("steers with priority now and swallows the aborted result caused by that steer", async () => {
    const events: AgentEvent[] = [];
    const adapter = new ClaudeAdapter(
      sdk(async function* (query) {
        yield { type: "system", subtype: "init", session_id: "sess_1" };
        const first = await query.nextMessage();
        assert.equal(first?.priority, undefined);
        yield { type: "stream_event", session_id: "sess_1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } } };
        const steer = await query.nextMessage();
        assert.equal(steer?.priority, "now");
        assert.equal(steer?.origin?.kind, "human");
        yield { type: "result", subtype: "success", session_id: "sess_1", is_error: false, stop_reason: "aborted", result: "" };
        yield {
          type: "result",
          subtype: "success",
          session_id: "sess_1",
          is_error: false,
          result: "steered",
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }),
    );
    const running = await adapter.start({
      cwd: "/tmp/work",
      nativeId: null,
      permissions: { permissionMode: "bypassPermissions" },
      onEvent: (event) => events.push(event),
      onNativeId: () => undefined,
    });
    await running.deliver("first");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await running.steer("focus");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const turns = events.filter((event) => event.type === "turn_completed");
    assert.equal(turns.length, 1);
    assert.equal(turns[0]?.data.status, "completed");
    assert.equal(turns[0]?.data.result, "steered");
    await running.close();
  });

  it("marks an explicit interrupt as interrupted", async () => {
    const events: AgentEvent[] = [];
    let queryRef: FakeQuery | undefined;
    const adapter = new ClaudeAdapter(
      sdk(async function* (query) {
        queryRef = query;
        yield { type: "system", subtype: "init", session_id: "sess_i" };
        await query.nextMessage();
        while (!query.interrupted) await new Promise((resolve) => setTimeout(resolve, 5));
        yield { type: "result", subtype: "success", session_id: "sess_i", is_error: false, stop_reason: "aborted", result: "" };
      }),
    );
    const running = await adapter.start({
      cwd: "/tmp/work",
      nativeId: null,
      permissions: {},
      onEvent: (event) => events.push(event),
      onNativeId: () => undefined,
    });
    await running.deliver("work");
    await new Promise((resolve) => setTimeout(resolve, 15));
    await running.interrupt();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(queryRef?.interrupted, true);
    assert.equal(events.find((event) => event.type === "turn_completed")?.data.status, "interrupted");
    await running.close();
  });

  it("defaults to opus when no model is set, honors KENNEL_CLAUDE_MODEL, and keeps an explicit model", async () => {
    const previous = process.env.KENNEL_CLAUDE_MODEL;
    const start = async (model?: string) => {
      const seen: { options?: Options } = {};
      const adapter = new ClaudeAdapter(
        sdk(async function* (query) {
          yield { type: "system", subtype: "init", session_id: "sess_m" };
          await query.nextMessage();
          yield { type: "result", subtype: "success", session_id: "sess_m", is_error: false, result: "ok" };
        }, seen),
      );
      const running = await adapter.start({
        cwd: "/tmp/work",
        nativeId: null,
        ...(model ? { model } : {}),
        permissions: {},
        onEvent: () => undefined,
        onNativeId: () => undefined,
      });
      await running.close();
      return seen.options?.model;
    };
    try {
      delete process.env.KENNEL_CLAUDE_MODEL;
      assert.equal(await start(), "opus");
      process.env.KENNEL_CLAUDE_MODEL = "claude-haiku-4-5";
      assert.equal(await start(), "claude-haiku-4-5");
      assert.equal(await start("claude-sonnet-5-5"), "claude-sonnet-5-5");
    } finally {
      if (previous === undefined) delete process.env.KENNEL_CLAUDE_MODEL;
      else process.env.KENNEL_CLAUDE_MODEL = previous;
    }
  });
});
