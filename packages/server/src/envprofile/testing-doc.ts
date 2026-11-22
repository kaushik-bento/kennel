import type { EnvProfile } from "./types.js";
import { sessionResources } from "./load.js";

/** Instructions written to KENNEL_TESTING.md and appended to the agent prompt. */
export function renderTestingDoc(profile: EnvProfile, options?: { fallback?: boolean; runtime?: "local" | "sandbox" }): string {
  const lines: string[] = [];
  lines.push(`# Kennel testing`, "");
  lines.push(
    profile.description
      ? `This session uses the \`${profile.name}\` environment. ${profile.description}`
      : `This session uses the \`${profile.name}\` environment.`,
  );
  if (options?.runtime === "local") {
    lines.push("");
    lines.push(
      "This session is on the kennel host, not inside a profile image. Start local services yourself before a check that needs them.",
    );
  } else if (options?.fallback) {
    lines.push("");
    lines.push(
      "The profile image is not available, so this session is using the base agent image. The local database snapshot was not restored. Say so if a check needs it.",
    );
  }
  lines.push("");
  lines.push(
    "Postgres, when this profile includes it, runs inside the sandbox. Its data directory is restored from the image snapshot onto the session volume the first time the sandbox starts, so the database is fresh for this session and stays with it. Redis, when included, listens on localhost. Do not point the database or cache variables at a remote host. The only database is the local one.",
  );
  lines.push("");
  const gate = Object.entries(profile.checks)
    .filter(([, check]) => check.default)
    .map(([name]) => `\`${name}\``);
  lines.push(
    gate.length > 0
      ? `The task is not done until these checks have passed: ${gate.join(", ")}.`
      : "This profile does not mark a default check gate.",
  );
  lines.push("");
  lines.push("## Checks");
  for (const [tier, check] of Object.entries(profile.checks)) {
    lines.push("", `### ${tier}${check.default ? " (default)" : ""}`, "", "```sh", check.command, "```");
    const size = sizeText(check.cpu, check.memoryMiB);
    if (size) lines.push("", `Sandbox for this tier: ${size}.`);
  }
  const session = sessionResources(profile);
  const sessionSize = sizeText(session.cpu, session.memoryMiB);
  if (sessionSize) {
    lines.push("", `This session's sandbox is ${sessionSize}. A \`full\` check may need the larger size listed on that tier.`);
  }
  if (Object.keys(profile.env).length > 0) {
    lines.push("", "## Environment", "");
    lines.push("These variables are set for the agent. They are test values, not production credentials.");
    lines.push("");
    for (const [key, value] of Object.entries(profile.env)) lines.push(`- \`${key}=${value}\``);
  }
  if (profile.cache.length > 0) {
    lines.push("", "## Cache", "", "These directories persist on the session volume:");
    lines.push("");
    for (const dir of profile.cache) lines.push(`- \`${dir}\``);
  }
  if (profile.deny.length > 0) {
    lines.push("", "## Do not", "");
    for (const item of profile.deny) lines.push(`- ${item}`);
  }
  if (profile.notes.length > 0) {
    lines.push("", "## Notes", "");
    for (const note of profile.notes) lines.push(`- ${note}`);
  }
  lines.push(
    "",
    "## Reporting",
    "",
    "After each check, append one JSON object per line to `.kennel/checks.jsonl` in the worktree:",
    "",
    '```json',
    '{"tier":"fast","command":"<the command>","exitCode":0,"summary":"what happened"}',
    "```",
    "",
    "Use the tier name from this document. This file is local bookkeeping. Do not commit it or this document.",
    "",
  );
  return lines.join("\n");
}

function sizeText(cpu: number | undefined, memoryMiB: number | undefined): string {
  const parts: string[] = [];
  if (cpu) parts.push(`${cpu} CPU`);
  if (memoryMiB) parts.push(`${memoryMiB} MiB memory`);
  return parts.join(", ");
}
