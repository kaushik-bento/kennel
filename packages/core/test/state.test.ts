import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bearerAuthorized, claudeAuthWarning, describeClaudeAuth } from "../src/auth.js";
import { connectorLine } from "../src/connector.js";
import { planAfterTurn, planBootRecovery, planPrompt } from "../src/state.js";

describe("planPrompt", () => {
  it("rejects stopped and error sessions", () => {
    assert.equal(planPrompt({ state: "stopped", mode: "queue", turnActive: false, runningSessions: 0, maxConcurrent: 2 }).type, "reject");
    assert.equal(planPrompt({ state: "error", mode: "steer", turnActive: false, runningSessions: 0, maxConcurrent: 2 }).type, "reject");
  });

  it("steers only into an active turn", () => {
    assert.deepEqual(
      planPrompt({ state: "running", mode: "steer", turnActive: true, runningSessions: 1, maxConcurrent: 1 }),
      { type: "steer" },
    );
    assert.equal(
      planPrompt({ state: "idle", mode: "steer", turnActive: false, runningSessions: 0, maxConcurrent: 1 }).type,
      "start",
    );
  });

  it("enqueues behind a running turn and starts when a slot is free", () => {
    assert.deepEqual(
      planPrompt({ state: "running", mode: "queue", turnActive: true, runningSessions: 1, maxConcurrent: 1 }),
      { type: "enqueue", state: "running" },
    );
    assert.equal(
      planPrompt({ state: "idle", mode: "queue", turnActive: false, runningSessions: 0, maxConcurrent: 1 }).type,
      "start",
    );
  });

  it("queues the session when every slot is taken", () => {
    assert.deepEqual(
      planPrompt({ state: "idle", mode: "queue", turnActive: false, runningSessions: 2, maxConcurrent: 2 }),
      { type: "enqueue", state: "queued" },
    );
    assert.deepEqual(
      planPrompt({ state: "queued", mode: "queue", turnActive: false, runningSessions: 2, maxConcurrent: 2 }),
      { type: "enqueue", state: "queued" },
    );
  });

  it("does not count this session's own slot against itself between turns", () => {
    assert.equal(
      planPrompt({ state: "running", mode: "queue", turnActive: false, runningSessions: 1, maxConcurrent: 1 }).type,
      "start",
    );
  });
});

describe("planAfterTurn", () => {
  it("stops, idles, or continues the queue", () => {
    assert.deepEqual(planAfterTurn({ stopRequested: true, queuedCount: 3 }), { state: "stopped", startNext: false });
    assert.deepEqual(planAfterTurn({ stopRequested: false, queuedCount: 0 }), { state: "idle", startNext: false });
    assert.deepEqual(planAfterTurn({ stopRequested: false, queuedCount: 1 }), { state: "running", startNext: true });
  });
});

describe("planBootRecovery", () => {
  it("marks a live turn as error and leaves queued sessions queued", () => {
    const recovered = planBootRecovery("running");
    assert.equal(recovered.state, "error");
    assert.equal(recovered.requeueRunningPrompt, true);
    assert.match(recovered.error ?? "", /resume/);
    assert.deepEqual(planBootRecovery("queued"), { state: "queued", error: null, requeueRunningPrompt: false });
    assert.deepEqual(planBootRecovery("idle"), { state: "idle", error: null, requeueRunningPrompt: false });
  });
});

describe("auth", () => {
  it("accepts only the exact bearer token", () => {
    assert.equal(bearerAuthorized("Bearer secret", "secret"), true);
    assert.equal(bearerAuthorized("Bearer secret-extra", "secret"), false);
    assert.equal(bearerAuthorized("Bearer se", "secret"), false);
    assert.equal(bearerAuthorized(undefined, "secret"), false);
    assert.equal(bearerAuthorized("Basic secret", "secret"), false);
    assert.equal(bearerAuthorized("Bearer ", "secret"), false);
  });

  it("warns when both Claude credentials are set and names the winner", () => {
    assert.equal(claudeAuthWarning({}), null);
    assert.match(
      claudeAuthWarning({ CLAUDE_CODE_OAUTH_TOKEN: "oauth", ANTHROPIC_API_KEY: "sk" }) ?? "",
      /ANTHROPIC_API_KEY takes precedence/,
    );
    assert.equal(describeClaudeAuth({ CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_API_KEY: "sk" }), "vertex");
    assert.equal(describeClaudeAuth({ ANTHROPIC_API_KEY: "sk" }), "api-key");
    assert.equal(describeClaudeAuth({ CLAUDE_CODE_OAUTH_TOKEN: "oauth" }), "oauth-token");
    assert.equal(describeClaudeAuth({}), "none");
  });
});

describe("connectorLine", () => {
  it("prints a pasteable MCP connector and rewrites wildcard binds", () => {
    const line = connectorLine({ host: "0.0.0.0", port: 8787, token: "tok" });
    const parsed = JSON.parse(line) as { url: string; headers: { Authorization: string } };
    assert.equal(parsed.url, "http://127.0.0.1:8787/mcp");
    assert.equal(parsed.headers.Authorization, "Bearer tok");
    const pub = JSON.parse(connectorLine({ host: "127.0.0.1", port: 1, token: "t", publicUrl: "https://kennel.example/" })) as {
      url: string;
    };
    assert.equal(pub.url, "https://kennel.example/mcp");
  });
});
