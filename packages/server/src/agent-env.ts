/** Environment handed to a coding agent. The control-plane triage key never leaves this process. */
const STRIPPED = new Set(["XAI_API_KEY", "KENNEL_ATTENTION_WEBHOOK"]);

export function agentEnv(
  base: NodeJS.ProcessEnv = process.env,
  options?: { strip?: string[]; extra?: Record<string, string> },
): Record<string, string> {
  const strip = new Set<string>([...STRIPPED, ...(options?.strip ?? [])]);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || strip.has(key)) continue;
    env[key] = value;
  }
  for (const [key, value] of Object.entries(options?.extra ?? {})) {
    if (!strip.has(key)) env[key] = value;
  }
  return env;
}
