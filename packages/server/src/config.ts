import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SandboxBackendKind, TriageMode } from "@kennel/core";

export interface KennelConfig {
  token: string;
  host: string;
  port: number;
  dataDir: string;
  maxConcurrent: number;
  publicUrl?: string;
  codexBin: string;
  echoDelayMs: number;
  /** Where agent processes run. Production deployments set `modal`. */
  backend: SandboxBackendKind;
  /** How long an idle session keeps its sandbox before it is torn down. 0 releases immediately. */
  sandboxIdleMs: number;
  /**
   * Hard ceiling for keeping an idle sandbox alive because processes the agent
   * started (bun install, tsc, tests) are still running. Counted from turn end.
   */
  sandboxBusyMaxMs: number;
  /** Extra Modal Secret names attached to every sandbox (eval keys). Missing ones are logged and skipped. */
  modalExtraSecrets: string[];
  modalApp: string;
  modalImage: string;
  /** Modal Secret *name*. The values are injected into the sandbox and never logged. */
  modalSecret: string;
  modalEnvironment?: string;
  /** Hard lifetime for a sandbox. Modal's own default is 5 minutes, which is too short for a coding turn. */
  modalSandboxTimeoutMs: number;
  /** idle: triage when the queue drains, on a failed/interrupted turn, or on a local heuristic. */
  triageMode: TriageMode;
  triageModel: string;
  /** Present only when XAI_API_KEY is set. Never logged and never sent to a sandbox. */
  xaiApiKey?: string;
  attentionWebhook?: string;
  xaiEndpoint?: string;
  /** Directory of environment profile YAML. Unset when the directory is absent. */
  envDir?: string;
  /** When a matched image is missing, build it in the background instead of blocking the session. */
  envAutobuild: boolean;
  /** Modal secret with only a GitHub token, used when the process has no GITHUB_TOKEN. */
  buildSecret?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KennelConfig {
  const token = env.KENNEL_TOKEN ?? "";
  if (!token) {
    throw new Error("KENNEL_TOKEN is required");
  }
  const port = env.KENNEL_PORT ? Number(env.KENNEL_PORT) : 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid KENNEL_PORT: ${env.KENNEL_PORT}`);
  }
  const maxConcurrent = env.KENNEL_MAX_CONCURRENT ? Number(env.KENNEL_MAX_CONCURRENT) : 4;
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error(`invalid KENNEL_MAX_CONCURRENT: ${env.KENNEL_MAX_CONCURRENT}`);
  }
  const echoDelayMs = env.KENNEL_ECHO_DELAY_MS ? Number(env.KENNEL_ECHO_DELAY_MS) : 5;
  if (!Number.isFinite(echoDelayMs) || echoDelayMs < 0) {
    throw new Error(`invalid KENNEL_ECHO_DELAY_MS: ${env.KENNEL_ECHO_DELAY_MS}`);
  }
  const backend = env.KENNEL_BACKEND || "local";
  if (backend !== "local" && backend !== "modal") {
    throw new Error(`invalid KENNEL_BACKEND: ${backend} (expected local or modal)`);
  }
  // Keep the sandbox (and the agent process) for 30 minutes after a turn so
  // background shells and subagents survive and the next prompt reattaches.
  const sandboxIdleMs = env.KENNEL_SANDBOX_IDLE_MS ? Number(env.KENNEL_SANDBOX_IDLE_MS) : 30 * 60 * 1000;
  if (!Number.isFinite(sandboxIdleMs) || sandboxIdleMs < 0) {
    throw new Error(`invalid KENNEL_SANDBOX_IDLE_MS: ${env.KENNEL_SANDBOX_IDLE_MS}`);
  }
  const sandboxBusyMaxMs = env.KENNEL_SANDBOX_BUSY_MAX_MS ? Number(env.KENNEL_SANDBOX_BUSY_MAX_MS) : 3 * 60 * 60 * 1000;
  if (!Number.isFinite(sandboxBusyMaxMs) || sandboxBusyMaxMs < 0) {
    throw new Error(`invalid KENNEL_SANDBOX_BUSY_MAX_MS: ${env.KENNEL_SANDBOX_BUSY_MAX_MS}`);
  }
  const modalExtraSecrets = (env.KENNEL_MODAL_EXTRA_SECRETS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  const modalSandboxTimeoutMs = env.KENNEL_MODAL_SANDBOX_TIMEOUT_MS
    ? Number(env.KENNEL_MODAL_SANDBOX_TIMEOUT_MS)
    : 8 * 60 * 60 * 1000;
  if (!Number.isFinite(modalSandboxTimeoutMs) || modalSandboxTimeoutMs < 60_000) {
    throw new Error(`invalid KENNEL_MODAL_SANDBOX_TIMEOUT_MS: ${env.KENNEL_MODAL_SANDBOX_TIMEOUT_MS}`);
  }
  const triageMode = env.KENNEL_TRIAGE_MODE || "idle";
  if (triageMode !== "idle" && triageMode !== "every_turn" && triageMode !== "off") {
    throw new Error(`invalid KENNEL_TRIAGE_MODE: ${triageMode} (expected idle, every_turn, or off)`);
  }
  const dataDir = path.resolve(env.KENNEL_DATA_DIR ?? path.join(os.homedir(), ".kennel"));
  mkdirSync(dataDir, { recursive: true });
  const config: KennelConfig = {
    token,
    host: env.KENNEL_HOST || "127.0.0.1",
    port,
    dataDir,
    maxConcurrent,
    codexBin: env.KENNEL_CODEX_BIN || "codex",
    echoDelayMs,
    backend,
    sandboxIdleMs,
    sandboxBusyMaxMs,
    modalExtraSecrets,
    modalApp: env.KENNEL_MODAL_APP || "kennel",
    modalImage: env.KENNEL_MODAL_IMAGE || "kennel-agent",
    modalSecret: env.KENNEL_MODAL_SECRET || "kennel-agent",
    modalSandboxTimeoutMs,
    triageMode,
    triageModel: env.KENNEL_TRIAGE_MODEL || "grok-4.3",
    envAutobuild: env.KENNEL_ENV_AUTOBUILD !== "0",
  };
  if (env.KENNEL_BUILD_SECRET) config.buildSecret = env.KENNEL_BUILD_SECRET;
  const envDir = env.KENNEL_ENV_DIR
    ? path.resolve(env.KENNEL_ENV_DIR)
    : existsSync(path.resolve("environments"))
      ? path.resolve("environments")
      : undefined;
  if (envDir) config.envDir = envDir;
  if (env.XAI_API_KEY) config.xaiApiKey = env.XAI_API_KEY;
  if (env.KENNEL_ATTENTION_WEBHOOK) config.attentionWebhook = env.KENNEL_ATTENTION_WEBHOOK;
  if (env.KENNEL_PUBLIC_URL) config.publicUrl = env.KENNEL_PUBLIC_URL;
  const modalEnvironment = env.KENNEL_MODAL_ENVIRONMENT || env.MODAL_ENVIRONMENT;
  if (modalEnvironment) config.modalEnvironment = modalEnvironment;
  return config;
}
