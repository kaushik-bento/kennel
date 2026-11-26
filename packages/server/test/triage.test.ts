import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { heuristicHit, terminalTurn } from "../src/triage/heuristic.js";
import { capHeadTail } from "../src/triage/transcript.js";
import { parseVerdict } from "../src/triage/xai.js";
import { startApp, type RunningApp } from "./helpers.js";

const apps: RunningApp[] = [];
const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  while (apps.length) await apps.pop()!.stop();
  while (servers.length) await servers.pop()!.close();
});

describe("triage heuristic", () => {
  test("matches a question, a wait, and an auth error", () => {
    assert.equal(heuristicHit("Please confirm?"), true);
    assert.equal(heuristicHit("Waiting for your approval before I push."), true);
    assert.equal(heuristicHit("rate limit reached"), true);
    assert.equal(heuristicHit("Edited src/app.ts and the tests passed."), false);
    assert.equal(terminalTurn("failed"), true);
    assert.equal(terminalTurn("interrupted"), true);
    assert.equal(terminalTurn("completed"), false);
  });

  test("keeps the head and the tail of a long transcript", () => {
    const text = "H".repeat(100) + "M".repeat(100) + "T".repeat(100);
    const capped = capHeadTail(text, 80);
    assert.ok(capped.startsWith("H"));
    assert.ok(capped.endsWith("T"));
    assert.match(capped, /truncated/);
    assert.ok(capped.length <= 80);
  });
});

describe("severity floor", () => {
  test("raises a waiting agent from info to warn and leaves other severities alone", () => {
    const waiting = {
      needsAttention: true,
      severity: "info",
      reasons: [{ kind: "agent_question", summary: "asked", evidence: "?" }],
      suggestedAction: "answer",
      batchSummary: "Asked a question.",
      sessionSummary: "Waiting.",
    };
    assert.equal(parseVerdict(JSON.stringify(waiting)).severity, "warn");
    assert.equal(
      parseVerdict(JSON.stringify({ ...waiting, reasons: [{ kind: "blocked", summary: "stuck", evidence: "approval" }] })).severity,
      "warn",
    );
    assert.equal(parseVerdict(JSON.stringify({ ...waiting, severity: "urgent" })).severity, "urgent");
    assert.equal(
      parseVerdict(
        JSON.stringify({
          ...waiting,
          reasons: [{ kind: "scope_drift", summary: "extra file", evidence: "notes.md" }],
        }),
      ).severity,
      "info",
    );
  });
});

describe("attention triage", () => {
  test("a question raises one flag from a single xAI call", async () => {
    const xai = await mockXai(() => ({ ...verdict(true), severity: "info" }));
    servers.push(xai);
    const app = await startApp({ triageMode: "idle", xaiApiKey: "test-key", xaiEndpoint: xai.url });
    apps.push(app);
    const session = await app.api("POST", "/sessions", { repo: app.repo, baseBranch: "main", agent: "echo" });
    const id = session.body.id as string;
    await app.api("POST", `/sessions/${id}/prompts`, { text: "Please confirm?", mode: "queue" });
    await waitFor(() => xai.requests.length >= 1 && flagCount(app, id));
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(xai.requests.length, 1);
    assert.equal(xai.requests[0]?.authorization, "Bearer test-key");
    const system = (xai.requests[0]?.body as { messages?: Array<{ content?: string }> }).messages?.[0]?.content ?? "";
    assert.match(system, /urgent: risky_action/);
    assert.match(system, /warn: the agent is blocked or waiting on a human \(agent_question, blocked\)/);
    assert.match(system, /info: everything else worth noting/);
    const flags = await app.api("GET", `/flags?sessionId=${id}`);
    assert.equal(flags.body.flags.length, 1);
    assert.equal(flags.body.flags[0].severity, "warn");
    const events = await app.api("GET", `/sessions/${id}/events?types=attention`, undefined, { Accept: "application/json" });
    assert.equal(events.body.events.length, 1);
    assert.equal(events.body.events[0].data.batchSummary, "The agent asked for confirmation.");
    const view = await app.api("GET", `/sessions/${id}`);
    assert.equal(view.body.sessionSummary, "Waiting on confirmation.");
    assert.equal(view.body.openFlags, 1);
    const acked = await app.api("POST", `/flags/${flags.body.flags[0].id}/ack`, {});
    assert.ok(acked.body.acknowledgedAt);
    const open = await app.api("GET", `/flags?sessionId=${id}`);
    assert.equal(open.body.flags.length, 0);
  });

  test("two clean turns share one idle triage and store a batch summary", async () => {
    const xai = await mockXai(() => verdict(false));
    servers.push(xai);
    const app = await startApp({
      echoDelayMs: 400,
      triageMode: "idle",
      xaiApiKey: "test-key",
      xaiEndpoint: xai.url,
    });
    apps.push(app);
    const session = await app.api("POST", "/sessions", { repo: app.repo, baseBranch: "main", agent: "echo" });
    const id = session.body.id as string;
    const first = await app.api("POST", `/sessions/${id}/prompts`, { text: "alpha", mode: "queue" });
    const second = await app.api("POST", `/sessions/${id}/prompts`, { text: "beta", mode: "queue" });
    await waitFor(() => xai.requests.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(xai.requests.length, 1);
    const transcript = JSON.stringify(xai.requests[0]?.body);
    assert.match(transcript, /alpha/);
    assert.match(transcript, /beta/);
    const summaries = await app.api("GET", `/sessions/${id}/summaries`);
    assert.equal(summaries.body.summaries.length, 1);
    assert.equal(summaries.body.summaries[0].fromPromptId, first.body.promptId);
    assert.equal(summaries.body.summaries[0].toPromptId, second.body.promptId);
    const view = await app.api("GET", `/sessions/${id}`);
    assert.equal(view.body.state, "idle");
    assert.equal(view.body.sessionSummary, "Waiting on confirmation.");
    assert.equal(view.body.lastBatchSummary, "The agent asked for confirmation.");
    assert.equal(view.body.openFlags, 0);
    const digest = await app.api("GET", "/digest");
    assert.equal(digest.body.sessions[0].id, id);
    assert.equal(digest.body.sessions[0].openFlags, 0);
  });

  test("a failing xAI endpoint is retried once and the session still goes idle", async () => {
    const xai = await mockXai((_count, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("unavailable");
    });
    servers.push(xai);
    const app = await startApp({ triageMode: "idle", xaiApiKey: "test-key", xaiEndpoint: xai.url });
    apps.push(app);
    const session = await app.api("POST", "/sessions", { repo: app.repo, baseBranch: "main", agent: "echo" });
    const id = session.body.id as string;
    await app.api("POST", `/sessions/${id}/prompts`, { text: "alpha", mode: "queue" });
    await waitFor(async () => {
      if (xai.requests.length < 2) return false;
      const view = await app.api("GET", `/sessions/${id}`);
      return view.body.state === "idle";
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(xai.requests.length, 2);
    const flags = await app.api("GET", `/flags?sessionId=${id}`);
    assert.equal(flags.body.flags.length, 0);
    const summaries = await app.api("GET", `/sessions/${id}/summaries`);
    assert.equal(summaries.body.summaries.length, 0);
  });
});

describe("lean events", () => {
  test("omits raw unless asked, and filters by type and limit", async () => {
    const app = await startApp();
    apps.push(app);
    const session = await app.api("POST", "/sessions", { repo: app.repo, baseBranch: "main", agent: "echo" });
    const id = session.body.id as string;
    await app.api("POST", `/sessions/${id}/prompts`, { text: "hello", mode: "queue" });
    await waitFor(async () => (await app.api("GET", `/sessions/${id}`)).body.state === "idle");
    const headers = { Accept: "application/json" };
    const plain = await app.api("GET", `/sessions/${id}/events`, undefined, headers);
    assert.ok(plain.body.events.length > 1);
    assert.equal(plain.body.events.some((event: { raw?: unknown }) => event.raw !== undefined), false);
    const withRaw = await app.api("GET", `/sessions/${id}/events?raw=1`, undefined, headers);
    assert.equal(withRaw.body.events.some((event: { raw?: unknown }) => event.raw !== undefined), true);
    const page = await app.api("GET", `/sessions/${id}/events?types=tool_call&limit=1`, undefined, headers);
    assert.equal(page.body.events.length, 1);
    assert.equal(page.body.events[0].type, "tool_call");
    assert.equal(page.body.cursor, page.body.events[0].id);
    const next = await app.api(
      "GET",
      `/sessions/${id}/events?types=tool_call&after=${page.body.cursor}`,
      undefined,
      headers,
    );
    assert.equal(next.body.events.length, 0);
  });
});

function verdict(needsAttention: boolean) {
  return {
    needsAttention,
    severity: "warn",
    reasons: needsAttention ? [{ kind: "agent_question", summary: "asked", evidence: "?" }] : [],
    suggestedAction: needsAttention ? "answer" : "",
    batchSummary: "The agent asked for confirmation.",
    sessionSummary: "Waiting on confirmation.",
  };
}

async function mockXai(respond: (count: number, res: ServerResponse) => object | void) {
  const requests: Array<{ authorization: string | undefined; body: unknown }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    requests.push({ authorization: req.headers.authorization, body });
    const payload = respond(requests.length, res);
    if (payload && !res.headersSent) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(payload) } }],
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function flagCount(app: RunningApp, id: string): Promise<boolean> {
  const flags = await app.api("GET", `/flags?sessionId=${id}`);
  return flags.body.flags.length === 1;
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out");
}
