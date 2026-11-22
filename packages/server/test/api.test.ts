import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { request, startApp, waitFor, type RunningApp } from "./helpers.js";

describe("http api", () => {
  let app: RunningApp;
  after(async () => {
    await app?.stop();
  });

  it("requires the bearer token and runs the echo queue", async () => {
    app = await startApp({ maxConcurrent: 1, echoDelayMs: 30 });
    const denied = await request(app.base, "GET", "/health", undefined, { Authorization: "Bearer nope" });
    assert.equal(denied.status, 401);
    const missing = await fetch(app.base + "/health");
    assert.equal(missing.status, 401);

    const created = await app.api("POST", "/sessions", {
      repo: app.repo,
      baseBranch: "main",
      agent: "echo",
      model: "echo-1",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.state, "idle");
    assert.equal(created.body.branch, `kennel/${created.body.id}`);
    assert.equal(created.body.queueDepth, 0);

    const listed = await app.api("GET", "/sessions");
    assert.equal(listed.body.sessions.length, 1);

    const first = await app.api("POST", `/sessions/${created.body.id}/prompts`, {
      text: "alpha",
      mode: "queue",
    });
    assert.equal(first.status, 202);
    assert.equal(first.body.delivery, "started");
    const second = await app.api("POST", `/sessions/${created.body.id}/prompts`, {
      text: "beta",
      mode: "queue",
    });
    assert.equal(second.body.delivery, "queued");
    assert.equal(second.body.queueDepth, 1);

    await waitFor(async () => {
      const session = await app.api("GET", `/sessions/${created.body.id}`);
      return session.body.state === "idle" && session.body.queueDepth === 0;
    });
    const events = await app.api("GET", `/sessions/${created.body.id}/events?after=0`, undefined, {
      Accept: "application/json",
    });
    const completed = events.body.events.filter((event: { type: string }) => event.type === "turn_completed");
    assert.equal(completed.length, 2);
    assert.equal(completed[0].data.result, "echo:alpha");
    assert.equal(completed[1].data.result, "echo:beta");
    assert.ok(completed[0].id < completed[1].id);

    const blocked = await app.api("POST", "/sessions", {
      repo: app.repo,
      baseBranch: "missing",
      agent: "echo",
    });
    assert.equal(blocked.status, 400);
  });
});

describe("steer, interrupt, stop, resume, concurrency", () => {
  it("steers an in-flight echo turn and then interrupts the queue", async () => {
    const app = await startApp({ echoDelayMs: 200 });
    try {
      const created = await app.api("POST", "/sessions", { repo: app.repo, baseBranch: "main", agent: "echo" });
      const id = created.body.id as string;
      await app.api("POST", `/sessions/${id}/prompts`, { text: "hello", mode: "queue" });
      const steered = await app.api("POST", `/sessions/${id}/prompts`, { text: "MORE", mode: "steer" });
      assert.equal(steered.body.delivery, "steered");
      await app.api("POST", `/sessions/${id}/prompts`, { text: "next", mode: "queue" });
      const interrupted = await app.api("POST", `/sessions/${id}/interrupt`);
      assert.equal(interrupted.status, 200);
      await waitFor(async () => {
        const session = await app.api("GET", `/sessions/${id}`);
        return session.body.state === "idle";
      });
      const events = await app.api("GET", `/sessions/${id}/events?after=0&waitMs=0`, undefined, {
        Accept: "application/json",
      });
      const turns = events.body.events.filter((event: { type: string }) => event.type === "turn_completed");
      assert.equal(turns[0].data.status, "interrupted");
      assert.equal(turns.at(-1).data.result, "echo:next");
    } finally {
      await app.stop();
    }
  });

  it("stop cancels the queue and resume allows a new prompt", async () => {
    const app = await startApp({ echoDelayMs: 250 });
    try {
      const created = await app.api("POST", "/sessions", { repo: app.repo, baseBranch: "main", agent: "echo" });
      const id = created.body.id as string;
      await app.api("POST", `/sessions/${id}/prompts`, { text: "run", mode: "queue" });
      await app.api("POST", `/sessions/${id}/prompts`, { text: "later", mode: "queue" });
      const stopped = await app.api("POST", `/sessions/${id}/stop`);
      assert.equal(stopped.body.state, "stopped");
      const rejected = await app.api("POST", `/sessions/${id}/prompts`, { text: "nope", mode: "queue" });
      assert.equal(rejected.status, 409);
      await waitFor(async () => (await app.api("GET", `/sessions/${id}`)).body.state === "stopped");
      const resumed = await app.api("POST", `/sessions/${id}/resume`);
      assert.equal(resumed.body.state, "idle");
      await app.api("POST", `/sessions/${id}/prompts`, { text: "after", mode: "queue" });
      await waitFor(async () => (await app.api("GET", `/sessions/${id}`)).body.state === "idle");
      const page = await app.api("GET", `/sessions/${id}/events?after=0`, undefined, { Accept: "application/json" });
      const results = page.body.events
        .filter((event: { type: string; data: { result?: string } }) => event.type === "turn_completed")
        .map((event: { data: { result?: string } }) => event.data.result);
      assert.ok(results.includes("echo:after"));
      assert.equal(results.includes("echo:later"), false);
    } finally {
      await app.stop();
    }
  });

  it("holds a second session in queued until a slot frees", async () => {
    const app = await startApp({ maxConcurrent: 1, echoDelayMs: 50 });
    try {
      const a = await app.api("POST", "/sessions", { repo: app.repo, baseBranch: "main", agent: "echo" });
      const b = await app.api("POST", "/sessions", { repo: app.repo, baseBranch: "main", agent: "echo" });
      await app.api("POST", `/sessions/${a.body.id}/prompts`, { text: "one", mode: "queue" });
      const queued = await app.api("POST", `/sessions/${b.body.id}/prompts`, { text: "two", mode: "queue" });
      assert.equal(queued.body.delivery, "queued");
      assert.equal(queued.body.state, "queued");
      await waitFor(async () => (await app.api("GET", `/sessions/${b.body.id}`)).body.state === "idle");
      const done = await app.api("GET", `/sessions/${b.body.id}/events?after=0`, undefined, { Accept: "application/json" });
      assert.equal(
        done.body.events.some((event: { type: string; data: { result?: string } }) => event.data.result === "echo:two"),
        true,
      );
    } finally {
      await app.stop();
    }
  });
});

describe("finish, close, and restart", () => {
  it("commits, pushes, and deletes the worktree", async () => {
    const app = await startApp();
    try {
      const created = await app.api("POST", "/sessions", { repo: app.repo, baseBranch: "main", agent: "echo" });
      const id = created.body.id as string;
      await writeFile(path.join(created.body.worktreePath, "note.txt"), "from the agent\n");
      const finished = await app.api("POST", `/sessions/${id}/finish`, {
        commitMessage: "add note",
        openPr: true,
      });
      assert.equal(finished.status, 200, JSON.stringify(finished.body));
      assert.equal(finished.body.committed, true);
      assert.equal(finished.body.pushed, true);
      assert.equal(finished.body.branch, `kennel/${id}`);
      assert.equal(finished.body.prUrl, null);
      assert.match(finished.body.prError ?? "", /gh/);
      const note = await app.api("GET", `/sessions/${id}`);
      assert.equal(note.body.state, "idle");
      const closed = await app.api("DELETE", `/sessions/${id}`);
      assert.equal(closed.body.deleted, true);
      const gone = await app.api("GET", `/sessions/${id}`);
      assert.equal(gone.status, 404);
      const list = await app.api("GET", "/sessions");
      assert.equal(list.body.sessions.length, 0);
    } finally {
      await app.stop();
    }
  });

  it("marks a running session errored after restart and resumes it", async () => {
    const app = await startApp({ echoDelayMs: 60_000 });
    const dataDir = app.dataDir;
    const repo = app.repo;
    const created = await app.api("POST", "/sessions", { repo, baseBranch: "main", agent: "echo" });
    const id = created.body.id as string;
    const started = await app.api("POST", `/sessions/${id}/prompts`, { text: "survive", mode: "queue" });
    assert.equal(started.body.state, "running");
    await app.app.close();

    const restarted = await startApp({ dataDir, echoDelayMs: 10 });
    try {
      const session = await restarted.api("GET", `/sessions/${id}`);
      assert.equal(session.body.state, "error");
      assert.match(session.body.error, /resume/);
      const resumed = await restarted.api("POST", `/sessions/${id}/resume`);
      assert.equal(resumed.body.state, "running");
      await waitFor(async () => (await restarted.api("GET", `/sessions/${id}`)).body.state === "idle");
      const events = await restarted.api("GET", `/sessions/${id}/events?after=0`, undefined, {
        Accept: "application/json",
      });
      assert.equal(
        events.body.events.some((event: { data: { result?: string } }) => event.data.result === "echo:survive"),
        true,
      );
      const native = (await restarted.api("GET", `/sessions/${id}`)).body.nativeSessionId as string;
      assert.match(native, /^echo_/);
    } finally {
      await restarted.stop();
      await readFile(path.join(repo, "README.md"));
    }
  });
});
