import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PassThrough } from "node:stream";
import { CodexAdapter, type CodexProcess } from "../src/adapters/codex.js";
import type { AgentEvent } from "../src/adapters/types.js";

function fakeServer(): {
  proc: CodexProcess;
  sent: () => Array<Record<string, unknown>>;
  push: (message: unknown) => void;
} {
  const input = new PassThrough();
  const output = new PassThrough();
  const stderr = new PassThrough();
  const sent: Array<Record<string, unknown>> = [];
  let buffer = "";
  let threadId = "thr_test";
  let turn = 0;
  input.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      const message = JSON.parse(line) as Record<string, any>;
      sent.push(message);
      if (message.method === "initialize") {
        write({ id: message.id, result: { userAgent: "test" } });
      } else if (message.method === "thread/start") {
        write({ id: message.id, result: { thread: { id: threadId } } });
      } else if (message.method === "thread/resume") {
        threadId = message.params.threadId;
        write({ id: message.id, result: { thread: { id: threadId } } });
      } else if (message.method === "turn/start") {
        turn += 1;
        const turnId = `turn_${turn}`;
        write({ id: message.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
        write({
          method: "turn/started",
          params: { threadId, turn: { id: turnId, status: "inProgress" } },
        });
        write({
          method: "item/agentMessage/delta",
          params: { delta: "hello", itemId: "item_1", threadId, turnId },
        });
        write({
          method: "item/started",
          params: {
            threadId,
            turnId,
            item: { type: "commandExecution", id: "call_1", command: "ls", cwd: "/work", status: "inProgress" },
          },
        });
        write({
          method: "item/commandExecution/outputDelta",
          params: { delta: "README.md\n", itemId: "call_1", threadId, turnId },
        });
        write({
          method: "item/completed",
          params: {
            threadId,
            turnId,
            item: {
              type: "commandExecution",
              id: "call_1",
              command: "ls",
              status: "completed",
              aggregatedOutput: "README.md\n",
              exitCode: 0,
            },
          },
        });
        write({
          method: "thread/tokenUsage/updated",
          params: {
            threadId,
            turnId,
            tokenUsage: {
              last: { inputTokens: 2, outputTokens: 3, totalTokens: 5, cachedInputTokens: 0, reasoningOutputTokens: 0 },
              total: { inputTokens: 2, outputTokens: 3, totalTokens: 5, cachedInputTokens: 0, reasoningOutputTokens: 0 },
            },
          },
        });
        write({
          method: "turn/completed",
          params: { threadId, turn: { id: turnId, status: "completed", items: [] } },
        });
      } else if (message.method === "turn/steer") {
        write({ id: message.id, result: { turnId: message.params.expectedTurnId } });
      } else if (message.method === "turn/interrupt") {
        write({ id: message.id, result: {} });
        write({
          method: "turn/completed",
          params: { threadId, turn: { id: message.params.turnId, status: "interrupted", items: [] } },
        });
      } else if (message.id !== undefined && String(message.method).includes("requestApproval")) {
        write({ id: message.id, result: { decision: "accept" } });
      }
    }
  });
  const proc: CodexProcess = {
    stdin: input,
    stdout: output,
    stderr,
    kill() {
      input.end();
      output.end();
    },
    on(event, listener) {
      if (event === "exit") input.on("end", () => listener(0));
    },
  };
  return {
    proc,
    sent: () => sent,
    push(message: unknown) {
      output.write(`${JSON.stringify(message)}\n`);
    },
  };
  function write(message: unknown) {
    output.write(`${JSON.stringify(message)}\n`);
  }
}

describe("codex adapter", () => {
  it("speaks thread/start and turn/start and normalizes streamed items", async () => {
    const fake = fakeServer();
    const events: AgentEvent[] = [];
    let native = "";
    const adapter = new CodexAdapter("codex", () => fake.proc);
    const running = await adapter.start({
      cwd: "/work",
      nativeId: null,
      model: "gpt-5.4",
      permissions: { sandbox: "workspace-write", approvalPolicy: "never", networkAccess: true },
      onEvent: (event) => events.push(event),
      onNativeId: (id) => {
        native = id;
      },
    });
    assert.equal(native, "thr_test");
    const start = fake.sent().find((message) => message.method === "thread/start");
    assert.equal((start?.params as { sandbox: string }).sandbox, "workspace-write");
    assert.equal((start?.params as { approvalPolicy: string }).approvalPolicy, "never");
    assert.equal(fake.sent().some((message) => message.method === "initialize"), true);
    assert.equal(fake.sent().some((message) => message.method === "initialized"), true);
    assert.equal("jsonrpc" in (fake.sent()[0] ?? {}), false);

    await running.deliver("summarize the repo");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const turn = fake.sent().find((message) => message.method === "turn/start");
    const params = turn?.params as {
      input: Array<{ type: string; text: string }>;
      sandboxPolicy: { type: string; networkAccess: boolean };
    };
    assert.deepEqual(params.input, [{ type: "text", text: "summarize the repo" }]);
    assert.equal(params.sandboxPolicy.type, "workspaceWrite");
    assert.equal(params.sandboxPolicy.networkAccess, true);
    assert.equal(events.find((event) => event.type === "message_delta")?.data.text, "hello");
    assert.equal(events.find((event) => event.type === "tool_call")?.data.name, "command");
    assert.equal(events.find((event) => event.type === "tool_result")?.data.output, "README.md\n");
    const completed = events.find((event) => event.type === "turn_completed");
    assert.equal(completed?.data.status, "completed");
    assert.equal((completed?.data.usage as { last: { inputTokens: number } }).last.inputTokens, 2);

    await running.steer("focus on tests");
    const steer = fake.sent().find((message) => message.method === "turn/steer");
    assert.equal((steer?.params as { expectedTurnId: string }).expectedTurnId, "turn_1");
    await running.interrupt();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(events.filter((event) => event.type === "turn_completed").at(-1)?.data.status, "interrupted");
    await running.close();
  });

  it("resumes an existing thread id", async () => {
    const fake = fakeServer();
    const adapter = new CodexAdapter("codex", () => fake.proc);
    const running = await adapter.start({
      cwd: "/work",
      nativeId: "thr_existing",
      permissions: {},
      onEvent: () => undefined,
      onNativeId: () => undefined,
    });
    assert.equal(running.nativeId, "thr_existing");
    const resume = fake.sent().find((message) => message.method === "thread/resume");
    assert.equal((resume?.params as { threadId: string }).threadId, "thr_existing");
    assert.equal((resume?.params as { excludeTurns: boolean }).excludeTurns, true);
    await running.close();
  });

  it("declines approval requests unless the policy is never", async () => {
    const fake = fakeServer();
    const adapter = new CodexAdapter("codex", () => fake.proc);
    const running = await adapter.start({
      cwd: "/work",
      nativeId: null,
      permissions: { approvalPolicy: "on-request", sandbox: "read-only" },
      onEvent: () => undefined,
      onNativeId: () => undefined,
    });
    fake.push({
      id: 99,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "thr_test", turnId: "turn_x", itemId: "call_x", command: "rm -rf /" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const response = fake.sent().find((message) => message.id === 99);
    assert.deepEqual(response?.result, { decision: "decline" });
    await running.close();
  });
});
