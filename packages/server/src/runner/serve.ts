import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import type { AgentKind, Permissions } from "@kennel/core";
import type { AgentAdapter, RunningAgent } from "../adapters/types.js";
import { GitWorkspace } from "../git.js";
import { decodeFrame, encodeFrame, type RpcRequest } from "./protocol.js";

export interface RunnerIo {
  input: Readable;
  output: Writable;
}

/**
 * kennel-runner. One process inside a sandbox. The control plane speaks a
 * framed JSON protocol on stdin/stdout; stdout is reserved for that protocol
 * so agent logs stay on stderr.
 */
export async function serveRunner(io: RunnerIo, adapters: Map<string, AgentAdapter>): Promise<void> {
  const write = (message: unknown) => {
    io.output.write(encodeFrame(message));
  };
  let git: GitWorkspace | null = null;
  let worktreePath = "";
  const running: { agent: RunningAgent | null } = { agent: null };
  const lines = createInterface({ input: io.input });

  const handle = async (request: RpcRequest): Promise<Record<string, unknown>> => {
    const params = request.params ?? {};
    if (request.method === "bootstrap") {
      const root = String(params.root ?? "");
      if (!root) throw new Error("bootstrap root is required");
      mkdirSync(path.join(root, "home"), { recursive: true });
      git = new GitWorkspace(root);
      const prepared = await git.ensure({
        repo: String(params.repo),
        baseBranch: String(params.baseBranch),
        branch: String(params.branch),
        sessionId: String(params.sessionId),
      });
      worktreePath = prepared.worktreePath;
      return { worktreePath: prepared.worktreePath, sourcePath: prepared.sourcePath, branch: prepared.branch };
    }
    if (request.method === "start") {
      if (!worktreePath) throw new Error("bootstrap before start");
      const kind = String(params.kind) as AgentKind;
      const adapter = adapters.get(kind);
      if (!adapter) throw new Error(`unknown agent: ${kind}`);
      if (running.agent) await running.agent.close().catch(() => undefined);
      const permissions = (params.permissions ?? {}) as Permissions;
      running.agent = await adapter.start({
        cwd: worktreePath,
        nativeId: typeof params.nativeId === "string" ? params.nativeId : null,
        ...(typeof params.model === "string" ? { model: params.model } : {}),
        permissions,
        onEvent: (event) => write({ method: "event", params: { type: event.type, data: event.data, raw: event.raw } }),
        onNativeId: (id) => write({ method: "native", params: { id } }),
      });
      return { nativeId: running.agent.nativeId };
    }
    if (request.method === "deliver") {
      if (!running.agent) throw new Error("agent is not started");
      await running.agent.deliver(String(params.text ?? ""));
      return {};
    }
    if (request.method === "steer") {
      if (!running.agent) throw new Error("agent is not started");
      await running.agent.steer(String(params.text ?? ""));
      return {};
    }
    if (request.method === "interrupt") {
      if (running.agent) await running.agent.interrupt();
      return {};
    }
    if (request.method === "close") {
      if (running.agent) await running.agent.close().catch(() => undefined);
      running.agent = null;
      return {};
    }
    if (request.method === "finish") {
      if (!git || !worktreePath) throw new Error("bootstrap before finish");
      const result = await git.finish({
        worktreePath,
        branch: String(params.branch),
        baseBranch: String(params.baseBranch),
        commitMessage: String(params.commitMessage),
        openPr: params.openPr !== false,
        repo: String(params.repo ?? ""),
      });
      return { ...result };
    }
    throw new Error(`unknown runner method: ${request.method}`);
  };

  for await (const line of lines) {
    const message = decodeFrame(line);
    if (!message || !("id" in message) || !("method" in message)) continue;
    const request = message as RpcRequest;
    try {
      const result = await handle(request);
      write({ id: request.id, result });
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      write({ id: request.id, error: { message: messageText } });
    }
  }
  await running.agent?.close().catch(() => undefined);
}

/**
 * One-time setup of the sandbox HOME (on the session volume).
 *
 * - `KENNEL_CODEX_AUTH_JSON`: contents of a ChatGPT-subscription
 *   `~/.codex/auth.json`. Written only when the volume has no auth.json yet,
 *   so Codex's own token refreshes on the volume are not overwritten.
 * - `GITHUB_TOKEN` / `GH_TOKEN`: registers `gh` as the git credential helper
 *   so private https clones and pushes work.
 * - A default git identity so agents can commit.
 */
export function prepareHome(env: NodeJS.ProcessEnv): void {
  const home = env.HOME;
  if (!home) return;
  mkdirSync(home, { recursive: true });
  const codexAuth = env.KENNEL_CODEX_AUTH_JSON;
  if (codexAuth && codexAuth.trim()) {
    const codexHome = env.CODEX_HOME || path.join(home, ".codex");
    const authPath = path.join(codexHome, "auth.json");
    if (!existsSync(authPath)) {
      mkdirSync(codexHome, { recursive: true, mode: 0o700 });
      writeFileSync(authPath, codexAuth, { mode: 0o600 });
      chmodSync(authPath, 0o600);
    }
  }
  const quiet = { stdio: "ignore" as const, env };
  if (env.GITHUB_TOKEN || env.GH_TOKEN) {
    spawnSync("gh", ["auth", "setup-git", "--hostname", "github.com"], quiet);
  }
  const name = spawnSync("git", ["config", "--global", "user.name"], { env, encoding: "utf8" });
  if (!name.stdout?.trim()) {
    spawnSync("git", ["config", "--global", "user.name", env.KENNEL_GIT_NAME || "kennel"], quiet);
    spawnSync("git", ["config", "--global", "user.email", env.KENNEL_GIT_EMAIL || "kennel@localhost"], quiet);
  }
}
