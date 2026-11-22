import type { AgentAdapter } from "./types.js";
import { ClaudeAdapter } from "./claude.js";
import { CodexAdapter, type CodexProcess } from "./codex.js";
import { EchoAdapter } from "./echo.js";
import type { KennelConfig } from "../config.js";

export interface AdapterOverrides {
  claude?: ClaudeAdapter;
  codexSpawn?: (bin: string, cwd: string) => CodexProcess;
  echoDelayMs?: number;
}

export function buildAdapters(config: Pick<KennelConfig, "codexBin" | "echoDelayMs">, overrides: AdapterOverrides = {}): Map<string, AgentAdapter> {
  const claude = overrides.claude ?? new ClaudeAdapter();
  const codex = new CodexAdapter(config.codexBin, overrides.codexSpawn);
  const echo = new EchoAdapter(overrides.echoDelayMs ?? config.echoDelayMs);
  return new Map<string, AgentAdapter>([
    ["claude", claude],
    ["codex", codex],
    ["echo", echo],
  ]);
}
