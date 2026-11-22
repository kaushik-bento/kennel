/** Values of these variables are stripped from any build log kennel prints. */
export const SECRET_ENV_NAMES = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "KENNEL_CODEX_AUTH_JSON",
  "XAI_API_KEY",
] as const;

export function redactSecrets(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text;
  for (const name of SECRET_ENV_NAMES) {
    const value = env[name];
    if (!value || value.length < 8) continue;
    out = out.split(value).join(`[redacted:${name}]`);
  }
  return out;
}

export function buildFailureMessage(imageId: string, exception: string): string {
  const detail = exception.trim() ? redactSecrets(exception.trim()) : "(no exception text)";
  return `[kennel] image build ${imageId} failed: ${detail}\nmodal image logs ${imageId}`;
}
