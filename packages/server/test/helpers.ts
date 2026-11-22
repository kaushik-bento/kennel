import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AddressInfo } from "node:net";
import { createKennel, type KennelApp } from "../src/create.js";
import type { AdapterOverrides } from "../src/adapters/index.js";
import type { KennelConfig } from "../src/config.js";
import type { SandboxBackendKind } from "@kennel/core";
import type { ModalHost } from "../src/sandbox/types.js";

const exec = promisify(execFile);

export const TOKEN = "test-token";

export async function git(args: string[], cwd?: string): Promise<string> {
  const { stdout } = await exec("git", args, { cwd });
  return stdout.toString();
}

export async function makeRepo(): Promise<{ root: string; src: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "kennel-repo-"));
  const origin = path.join(root, "origin.git");
  const src = path.join(root, "src");
  await git(["init", "--bare", "-b", "main", origin]);
  await git(["clone", origin, src]);
  await writeFile(path.join(src, "README.md"), "hello\n");
  await commitAll(src, "init");
  await git(["push", "origin", "HEAD:main"], src);
  return { root, src };
}

export async function commitAll(cwd: string, message: string): Promise<void> {
  await git(["add", "-A"], cwd);
  await git(["-c", "user.email=test@localhost", "-c", "user.name=test", "commit", "-m", message], cwd);
}

export interface RunningApp {
  app: KennelApp;
  base: string;
  dataDir: string;
  repo: string;
  repoRoot: string;
  api(method: string, pathname: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: any }>;
  stop(): Promise<void>;
}

export async function startApp(options?: {
  maxConcurrent?: number;
  echoDelayMs?: number;
  adapters?: AdapterOverrides;
  dataDir?: string;
  backend?: SandboxBackendKind;
  sandboxIdleMs?: number;
  modalHost?: ModalHost;
  triageMode?: KennelConfig["triageMode"];
  xaiApiKey?: string;
  xaiEndpoint?: string;
  attentionWebhook?: string;
}): Promise<RunningApp> {
  const dataDir = options?.dataDir ?? (await mkdtemp(path.join(tmpdir(), "kennel-data-")));
  await mkdir(dataDir, { recursive: true });
  const repo = await makeRepo();
  const config: KennelConfig = {
    token: TOKEN,
    host: "127.0.0.1",
    port: 0,
    dataDir,
    maxConcurrent: options?.maxConcurrent ?? 2,
    codexBin: "codex",
    echoDelayMs: options?.echoDelayMs ?? 20,
    backend: options?.backend ?? "local",
    sandboxIdleMs: options?.sandboxIdleMs ?? 0,
    modalApp: "kennel-test",
    modalImage: "kennel-agent",
    modalSecret: "kennel-agent",
    modalSandboxTimeoutMs: 60_000,
    triageMode: options?.triageMode ?? "off",
    triageModel: "grok-4.3",
    envAutobuild: false,
    ...(options?.xaiApiKey ? { xaiApiKey: options.xaiApiKey } : {}),
    ...(options?.xaiEndpoint ? { xaiEndpoint: options.xaiEndpoint } : {}),
    ...(options?.attentionWebhook ? { attentionWebhook: options.attentionWebhook } : {}),
  };
  const app = await createKennel({
    config,
    ...(options?.adapters ? { adapters: options.adapters } : {}),
    ...(options?.modalHost ? { modalHost: options.modalHost } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(0, "127.0.0.1", () => {
      app.server.off("error", reject);
      resolve();
    });
  });
  const address = app.server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  return {
    app,
    base,
    dataDir,
    repo: repo.src,
    repoRoot: repo.root,
    api(method, pathname, body, headers) {
      return request(base, method, pathname, body, headers);
    },
    async stop() {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(repo.root, { recursive: true, force: true });
    },
  };
}

export async function request(
  base: string,
  method: string,
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(base + pathname, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

export async function waitFor(fn: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("timed out waiting for condition");
}

export async function readSse(
  base: string,
  pathname: string,
  onEvent: (event: { id?: string; event?: string; data?: any }) => "stop" | undefined,
  headers: Record<string, string> = {},
): Promise<void> {
  const controller = new AbortController();
  const response = await fetch(base + pathname, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "text/event-stream", ...headers },
    signal: controller.signal,
  });
  if (!response.ok || !response.body) {
    controller.abort();
    throw new Error(`sse failed: ${response.status}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        if (!chunk.trim() || chunk.startsWith(":")) continue;
        const parsed: { id?: string; event?: string; data?: any } = {};
        for (const line of chunk.split("\n")) {
          if (line.startsWith("id:")) parsed.id = line.slice(3).trim();
          else if (line.startsWith("event:")) parsed.event = line.slice(6).trim();
          else if (line.startsWith("data:")) parsed.data = JSON.parse(line.slice(5).trim());
        }
        if (onEvent(parsed) === "stop") return;
      }
    }
  } finally {
    controller.abort();
    reader.releaseLock?.();
  }
}
