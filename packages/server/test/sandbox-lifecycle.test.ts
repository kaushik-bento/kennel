import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter, isEmptyResult, type ClaudeSdk } from "../src/adapters/claude.js";
import { buildAdapters } from "../src/adapters/index.js";
import type { AgentEvent } from "../src/adapters/types.js";
import { loadConfig } from "../src/config.js";
import { hashLockfiles, imageName } from "../src/envprofile/hash.js";
import { planImage } from "../src/envprofile/image-plan.js";
import { loadProfiles, matchProfile, parseProfile } from "../src/envprofile/load.js";
import { selectSessionImage } from "../src/envprofile/select.js";
import { busyProcesses, readProcs, type ProcInfo } from "../src/runner/activity.js";
import { serveRunner, type RunnerActivity } from "../src/runner/serve.js";
import { sandboxEnv } from "../src/sandbox/modal-host.js";
import type { ModalHost, ModalOpenSpec, RunnerStdio } from "../src/sandbox/types.js";
import { startApp, waitFor, type RunningApp } from "./helpers.js";

const proc = (pid: number, ppid: number, start: number, command: string, state = "S"): ProcInfo => ({
  pid,
  ppid,
  start,
  command,
  state,
});

describe("runner activity", () => {
  it("counts work the agent started and ignores the CLI, its startup helpers, MCP servers, and zombies", () => {
    const procs = [
      proc(10, 1, 0, "node runner.js"),
      proc(20, 10, 1000, "node claude-cli.js"),
      proc(21, 20, 1050, "typescript-language-server --stdio"),
      proc(22, 20, 5000, "bash -c bun install"),
      proc(23, 22, 5100, "bun install"),
      proc(24, 20, 6000, "node mcp-server.js"),
      proc(25, 20, 7000, "sleep 1", "Z"),
      proc(30, 1, 9000, "unrelated"),
    ];
    const busy = busyProcesses(10, procs).map((p) => p.pid).sort();
    assert.deepEqual(busy, [22, 23]);
    assert.deepEqual(busyProcesses(10, procs.slice(0, 2)), []);
  });

  it("parses /proc stat lines, including a comm with spaces and parentheses", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kennel-proc-"));
    mkdirSync(path.join(dir, "42"));
    const fields = ["S", "7", ...Array.from({ length: 17 }, () => "0"), "12345", "0"];
    writeFileSync(path.join(dir, "42", "stat"), `42 (my (odd) cmd) ${fields.join(" ")}`);
    writeFileSync(path.join(dir, "42", "cmdline"), "bun\0install\0");
    mkdirSync(path.join(dir, "self"));
    assert.deepEqual(readProcs(dir), [{ pid: 42, ppid: 7, state: "S", start: 12345, command: "bun install" }]);
    assert.deepEqual(readProcs(path.join(dir, "missing")), []);
  });
});

describe("claude empty turns", () => {
  it("recognizes a 0-turn 0-token result", () => {
    assert.equal(
      isEmptyResult({ type: "result", subtype: "success", num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 } }),
      true,
    );
    assert.equal(
      isEmptyResult({ type: "result", subtype: "success", num_turns: 1, usage: { input_tokens: 5, output_tokens: 3 } }),
      false,
    );
  });

  function scriptedSdk(results: Array<Record<string, unknown>>, prompts: string[]): ClaudeSdk {
    return {
      query({ prompt }) {
        const queue: SDKUserMessage[] = [];
        let wake: (() => void) | null = null;
        void (async () => {
          for await (const message of prompt) {
            queue.push(message);
            wake?.();
          }
        })();
        async function* run(): AsyncGenerator<unknown> {
          yield { type: "system", subtype: "init", session_id: "sess_e" };
          for (const result of results) {
            while (queue.length === 0) await new Promise<void>((resolve) => (wake = resolve));
            const message = queue.shift() as SDKUserMessage;
            prompts.push(String(message.message.content));
            yield { session_id: "sess_e", ...result };
          }
        }
        const iterator = run();
        return Object.assign(iterator, {
          interrupt: async () => undefined,
        }) as unknown as ReturnType<ClaudeSdk["query"]>;
      },
    };
  }

  const empty = { type: "result", subtype: "success", is_error: false, result: "", num_turns: 0, usage: { input_tokens: 0, output_tokens: 0 } };
  const real = { type: "result", subtype: "success", is_error: false, result: "done", num_turns: 2, usage: { input_tokens: 9, output_tokens: 4 } };

  it("retries a resumed prompt once when the CLI returns an empty turn", async () => {
    const events: AgentEvent[] = [];
    const prompts: string[] = [];
    const running = await new ClaudeAdapter(scriptedSdk([empty, real], prompts)).start({
      cwd: "/tmp/work",
      nativeId: "sess_old",
      emptyRetryMs: 5,
      permissions: { permissionMode: "bypassPermissions" },
      onEvent: (event) => events.push(event),
      onNativeId: () => undefined,
    });
    await running.deliver("run the voice tests");
    await waitFor(async () => events.some((event) => event.type === "turn_completed"));
    const completed = events.filter((event) => event.type === "turn_completed");
    assert.equal(completed.length, 1);
    assert.equal(completed[0]?.data.status, "completed");
    assert.equal(completed[0]?.data.result, "done");
    assert.deepEqual(prompts, ["run the voice tests", "run the voice tests"]);
    await running.close();
  });

  it("fails the turn instead of reporting success after two empty turns", async () => {
    const events: AgentEvent[] = [];
    const running = await new ClaudeAdapter(scriptedSdk([empty, empty], [])).start({
      cwd: "/tmp/work",
      emptyRetryMs: 5,
      permissions: { permissionMode: "bypassPermissions" },
      onEvent: (event) => events.push(event),
      onNativeId: () => undefined,
    });
    await running.deliver("hello");
    await waitFor(async () => events.some((event) => event.type === "turn_completed"));
    const completed = events.find((event) => event.type === "turn_completed");
    assert.equal(completed?.data.status, "failed");
    assert.match(String(completed?.data.error), /empty turn/);
    await running.close();
  });
});

function fakeHost(activity: () => RunnerActivity): { host: ModalHost; directory: string; opened: string[] } {
  const directory = mkdtempSync(path.join(tmpdir(), "kennel-busy-"));
  const opened: string[] = [];
  let counter = 0;
  const host: ModalHost = {
    async open(spec: ModalOpenSpec): Promise<RunnerStdio> {
      const volume = path.join(directory, spec.volumeName);
      mkdirSync(volume, { recursive: true });
      const input = new PassThrough();
      const rewritten = new PassThrough();
      const output = new PassThrough();
      input.on("data", (chunk: Buffer | string) => {
        rewritten.write(chunk.toString().replaceAll('"/var/kennel"', JSON.stringify(volume)));
      });
      void serveRunner({ input: rewritten, output }, buildAdapters({ codexBin: "codex", echoDelayMs: 5 }), { activity });
      await new Promise((resolve) => setImmediate(resolve));
      const sandboxId = `sb-${++counter}`;
      opened.push(sandboxId);
      return {
        sandboxId,
        write: async (frame) => {
          input.write(frame);
        },
        async *lines() {
          for await (const line of createInterface({ input: output })) yield line;
        },
        close: async () => {
          input.end();
          rewritten.end();
          output.end();
        },
      };
    },
    async deleteVolume(volumeName: string) {
      await rm(path.join(directory, volumeName), { recursive: true, force: true });
    },
  };
  return { host, directory, opened };
}

describe("sandbox teardown", () => {
  const cleanup: Array<() => Promise<void>> = [];
  after(async () => {
    for (const fn of cleanup) await fn();
  });

  it("keeps a sandbox with background work past the idle timeout and reattaches to it", async () => {
    let busy = 1;
    const fake = fakeHost(() => ({ busy, processes: busy ? ["bun install"] : [] }));
    const app: RunningApp = await startApp({
      backend: "modal",
      modalHost: fake.host,
      echoDelayMs: 5,
      sandboxIdleMs: 40,
      sandboxBusyMaxMs: 60_000,
    });
    cleanup.push(() => app.stop(), () => rm(fake.directory, { recursive: true, force: true }));
    const created = await app.api("POST", "/sessions", { repo: app.repo, baseBranch: "main", agent: "echo" });
    const id = created.body.id as string;
    await app.api("POST", `/sessions/${id}/prompts`, { text: "start a long build", mode: "queue" });
    await waitFor(async () => (await app.api("GET", `/sessions/${id}`)).body.state === "idle");
    const sandboxId = (await app.api("GET", `/sessions/${id}`)).body.sandboxId as string;
    assert.match(sandboxId, /^sb-/);
    const openedBefore = fake.opened.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal((await app.api("GET", `/sessions/${id}`)).body.sandboxId, sandboxId, "busy sandbox was released");

    await app.api("POST", `/sessions/${id}/prompts`, { text: "check the build", mode: "queue" });
    await waitFor(async () => {
      const events = await app.api("GET", `/sessions/${id}/events?after=0`, undefined, { Accept: "application/json" });
      return events.body.events.filter((event: { type: string }) => event.type === "turn_completed").length === 2;
    });
    assert.equal(fake.opened.length, openedBefore, "second turn did not reattach to the same sandbox");
    assert.equal((await app.api("GET", `/sessions/${id}`)).body.sandboxId, sandboxId);

    busy = 0;
    await waitFor(async () => (await app.api("GET", `/sessions/${id}`)).body.sandboxId === null);
  });

  it("releases a busy sandbox at the hard limit", async () => {
    const fake = fakeHost(() => ({ busy: 2, processes: ["sleep 99999", "tsc -b"] }));
    const app: RunningApp = await startApp({
      backend: "modal",
      modalHost: fake.host,
      echoDelayMs: 5,
      sandboxIdleMs: 20,
      sandboxBusyMaxMs: 150,
    });
    cleanup.push(() => app.stop(), () => rm(fake.directory, { recursive: true, force: true }));
    const created = await app.api("POST", "/sessions", { repo: app.repo, baseBranch: "main", agent: "echo" });
    const id = created.body.id as string;
    await app.api("POST", `/sessions/${id}/prompts`, { text: "go", mode: "queue" });
    await waitFor(async () => (await app.api("GET", `/sessions/${id}`)).body.state === "idle");
    await waitFor(async () => (await app.api("GET", `/sessions/${id}`)).body.sandboxId === null);
    const events = await app.api("GET", `/sessions/${id}/events?after=0`, undefined, { Accept: "application/json" });
    const released = events.body.events.find(
      (event: { type: string; data: { sandbox?: string } }) => event.type === "status" && event.data.sandbox === "released",
    );
    assert.equal(released?.data.reason, "busy limit reached");
  });
});

describe("sandbox environment", () => {
  it("defaults keep sandboxes 30 minutes, cap busy keep at 3 hours, and attach no extra secrets", () => {
    const config = loadConfig({ KENNEL_TOKEN: "t" } as NodeJS.ProcessEnv);
    assert.equal(config.sandboxIdleMs, 30 * 60 * 1000);
    assert.equal(config.sandboxBusyMaxMs, 3 * 60 * 60 * 1000);
    assert.deepEqual(config.modalExtraSecrets, []);
    const custom = loadConfig({
      KENNEL_TOKEN: "t",
      KENNEL_MODAL_EXTRA_SECRETS: " openai-eval-key, fish-audio-api-key ,,",
    } as NodeJS.ProcessEnv);
    assert.deepEqual(custom.modalExtraSecrets, ["openai-eval-key", "fish-audio-api-key"]);
  });

  it("puts package caches on the ephemeral disk and sizes the node heap to the sandbox", () => {
    const env = sandboxEnv({ memoryMiB: 16384 });
    assert.equal(env.HOME, "/var/kennel/home");
    assert.match(env.BUN_INSTALL_CACHE_DIR ?? "", /^\/root\//);
    assert.doesNotMatch(Object.values(env).join(" "), /\/var\/kennel\/(?!home)/);
    assert.equal(env.NODE_OPTIONS, "--max-old-space-size=9830");
    assert.equal(sandboxEnv({}).NODE_OPTIONS, undefined);
    assert.equal("ANTHROPIC_API_KEY" in env, false);
  });

  it("uses the newest image built for an earlier lockfile before the bare base image", async () => {
    const profilesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../environments");
    const profile = matchProfile(loadProfiles(profilesDir), "https://github.com/example/app");
    assert.ok(profile);
    const current = [{ path: "package-lock.json", content: "lock-c" }];
    const older = [[{ path: "package-lock.json", content: "lock-b" }], [{ path: "package-lock.json", content: "lock-a" }]];
    const published = new Set([imageName(profile, hashLockfiles(older[0]!)), imageName(profile, hashLockfiles(older[1]!))]);
    const decision = await selectSessionImage({
      fallbackImage: "kennel-agent",
      profile,
      lockfiles: current,
      previousLockfiles: older,
      imageExists: (name) => published.has(name),
      log: () => undefined,
    });
    assert.equal(decision.fallback, false);
    assert.equal(decision.stale, true);
    assert.equal(decision.image, imageName(profile, hashLockfiles(older[0]!)));
    assert.equal(decision.desired, imageName(profile, hashLockfiles(current)));
  });

  it("pins the bun version the profile asks for and links bunx", () => {
    const profile = parseProfile(
      ["name: buntest", "repos: [https://github.com/example/bun]", "runtimes:", "  - name: bun", '    version: "1.4.4"'].join("\n"),
      "buntest.yaml",
    );
    const commands = planImage(profile)
      .commands.map((command) => {
        const encoded = /^RUN echo (\S+) \| base64 -d \| bash$/.exec(command)?.[1];
        return encoded ? Buffer.from(encoded, "base64").toString("utf8") : command;
      })
      .join("\n");
    assert.match(commands, /bash -s 'bun-v1\.4\.4'/);
    assert.match(commands, /\/usr\/local\/bin\/bunx/);
    assert.doesNotMatch(commands, /BUN_VERSION/);
  });
});
