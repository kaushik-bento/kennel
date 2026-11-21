import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Compare a bearer credential to the configured token.
 * Both sides are hashed first so the compare stays fixed-length even when
 * the presented secret is a different size.
 */
export function bearerAuthorized(authorizationHeader: string | undefined, token: string): boolean {
  const presented = authorizationHeader?.startsWith("Bearer ")
    ? authorizationHeader.slice("Bearer ".length)
    : "";
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(token).digest();
  return presented.length > 0 && timingSafeEqual(a, b);
}

export function claudeAuthWarning(env: NodeJS.ProcessEnv): string | null {
  if (env.CLAUDE_CODE_OAUTH_TOKEN && env.ANTHROPIC_API_KEY) {
    return "Both CLAUDE_CODE_OAUTH_TOKEN and ANTHROPIC_API_KEY are set. ANTHROPIC_API_KEY takes precedence; Claude Code ignores the OAuth token.";
  }
  return null;
}

export type ClaudeAuthMode = "vertex" | "api-key" | "oauth-token" | "none";

export function describeClaudeAuth(env: NodeJS.ProcessEnv): ClaudeAuthMode {
  if (env.CLAUDE_CODE_USE_VERTEX) return "vertex";
  if (env.ANTHROPIC_API_KEY) return "api-key";
  if (env.CLAUDE_CODE_OAUTH_TOKEN) return "oauth-token";
  return "none";
}
