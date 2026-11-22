/** Environment handed to a coding agent. The control-plane triage key never leaves this process. */
const STRIPPED = new Set(["XAI_API_KEY", "KENNEL_ATTENTION_WEBHOOK"]);

export function agentEnv(base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || STRIPPED.has(key)) continue;
    env[key] = value;
  }
  return env;
}
