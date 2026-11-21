import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { buildAdapters } from "../src/adapters/index.js";
import { serveRunner } from "../src/runner/serve.js";
import type { ModalHost, ModalOpenSpec, RunnerStdio } from "../src/sandbox/types.js";
import { startApp, waitFor, type RunningApp } from "./helpers.js";

function fakeModalHost(echoDelayMs: number): { host: ModalHost; directory: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "kennel-modal-"));
  const host: ModalHost = {
    async open(spec: ModalOpenSpec): Promise<RunnerStdio> {
      const volume = path.join(directory, spec.volumeName);
      mkdirSync(volume, { recursive: true });
      const input = new PassThrough();
      const rewritten = new PassThrough();
      const output = new PassThrough();
      input.on("data", (chunk: Buffer | string) => {
        const text = chunk.toString();
        rewritten.write(text.replaceAll('"/var/kennel"', JSON.stringify(volume)));
      });
      const adapters = buildAdapters({ codexBin: "codex", echoDelayMs });
      void serveRunner({ input: rewritten, output }, adapters);
      await new Promise((resolve) => setImmediate(resolve));
      return {
        sandboxId: `sb-${spec.volumeName}`,
        write: async (frame) => {
          input.write(frame);
        },
        async *lines() {
          const reader = createInterface({ input: output });
          for await (const line of reader) yield line;
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
  return { host, directory };
}

describe("modal sandbox backend", () => {
  let app: RunningApp;
  let directory = "";

  after(async () => {
    await app?.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("bootstraps a volume, drops the sandbox when idle, and resumes on the same native id", async () => {
    const fake = fakeModalHost(15);
    directory = fake.directory;
    app = await startApp({ backend: "modal", modalHost: fake.host, echoDelayMs: 15, sandboxIdleMs: 0 });
    const created = await app.api("POST", "/sessions", { repo: app.repo, baseBranch: "main", agent: "echo" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.backend, "modal");
    assert.equal(created.body.sandboxId, null);
    const volumeRoot = path.dirname(path.dirname(created.body.worktreePath as string));
    assert.equal(existsSync(path.join(volumeRoot, "home")), true);
    assert.equal(existsSync(path.join(created.body.worktreePath as string, ".git")), true);

    const started = await app.api("POST", `/sessions/${created.body.id}/prompts`, { text: "first", mode: "queue" });
    assert.equal(started.body.delivery, "started");
    await waitFor(async () => (await app.api("GET", `/sessions/${created.body.id}`)).body.state === "idle");
    await waitFor(async () => (await app.api("GET", `/sessions/${created.body.id}`)).body.sandboxId === null);
    const native = (await app.api("GET", `/sessions/${created.body.id}`)).body.nativeSessionId as string;
    assert.match(native, /^echo_/);

    await app.api("POST", `/sessions/${created.body.id}/prompts`, { text: "second", mode: "queue" });
    await waitFor(async () => (await app.api("GET", `/sessions/${created.body.id}`)).body.state === "idle");
    const again = await app.api("GET", `/sessions/${created.body.id}`);
    assert.equal(again.body.nativeSessionId, native);
    const events = await app.api("GET", `/sessions/${created.body.id}/events?after=0`, undefined, {
      Accept: "application/json",
    });
    const results = events.body.events
      .filter((event: { type: string }) => event.type === "turn_completed")
      .map((event: { data: { result?: string } }) => event.data.result);
    assert.deepEqual(results, ["echo:first", "echo:second"]);

    await writeFile(path.join(created.body.worktreePath as string, "note.txt"), "shipped\n");
    const finished = await app.api("POST", `/sessions/${created.body.id}/finish`, {
      commitMessage: "ship note",
      openPr: false,
    });
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    assert.equal(finished.body.committed, true);
    assert.equal(finished.body.pushed, true);

    const closed = await app.api("DELETE", `/sessions/${created.body.id}`);
    assert.equal(closed.body.deleted, true);
    assert.equal(existsSync(volumeRoot), false);
  });
});
