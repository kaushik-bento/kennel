import { readFileSync } from "node:fs";
import path from "node:path";
import { CHECK_TIERS, type CheckObservation, type CheckRecord, type CheckTier } from "./types.js";

export interface CheckReportInput {
  tiers: Array<{ tier: CheckTier | string; command: string }>;
  events: Array<{ type: string; data: Record<string, unknown> }>;
  records: CheckRecord[];
}

/** Markdown section appended to the pull request body. */
export function renderCheckReport(input: CheckReportInput): string {
  if (input.tiers.length === 0 && input.records.length === 0) return "";
  const observed = observationsFromEvents(input.tiers, input.events);
  const lines = ["## Kennel checks", "", "| Tier | Result | Command | Source |", "| --- | --- | --- | --- |"];
  const seen = new Set<string>();
  for (const tier of input.tiers) {
    seen.add(tier.tier);
    const record = input.records.find((item) => item.tier === tier.tier);
    const observation = observed.find((item) => item.tier === tier.tier);
    lines.push(`| ${tier.tier} | ${resultCell(record, observation)} | \`${escapeCell(tier.command)}\` | ${sourceCell(record, observation)} |`);
  }
  for (const record of input.records) {
    if (seen.has(record.tier)) continue;
    lines.push(
      `| ${record.tier} | ${exitText(record.exitCode)} | \`${escapeCell(record.command ?? "")}\` | agent report |`,
    );
  }
  const required = input.tiers.filter((tier) => tier.tier === "fast" || tier.tier === "targeted");
  const missing = required.filter((tier) => {
    const record = input.records.find((item) => item.tier === tier.tier);
    const observation = observed.find((item) => item.tier === tier.tier);
    return !passed(record, observation);
  });
  lines.push("");
  if (missing.length === 0 && required.length > 0) {
    lines.push("Required checks (`fast` and `targeted`) passed.");
  } else if (missing.length > 0) {
    lines.push(`Required checks not recorded as passed: ${missing.map((tier) => `\`${tier.tier}\``).join(", ")}.`);
  }
  lines.push("");
  return lines.join("\n");
}

export function observationsFromEvents(
  tiers: Array<{ tier: string; command: string }>,
  events: Array<{ type: string; data: Record<string, unknown> }>,
): CheckObservation[] {
  const calls = new Map<string, { command: string; tier: string }>();
  for (const event of events) {
    if (event.type !== "tool_call") continue;
    const command = commandOf(event.data);
    if (!command) continue;
    const match = tiers.find((tier) => normalize(command).includes(normalize(tier.command)));
    if (!match) continue;
    const id = String(event.data.toolUseId ?? command);
    calls.set(id, { command, tier: match.tier });
  }
  return tiers.map((tier) => {
    const call = [...calls.entries()].find(([, value]) => value.tier === tier.tier);
    if (!call) return { tier: tier.tier as CheckTier, command: tier.command, seen: false, exitCode: null, isError: false };
    const result = events.find(
      (event) => event.type === "tool_result" && String(event.data.toolUseId ?? "") === call[0],
    );
    const exitCode = result ? exitCodeOf(result.data.output) : null;
    return {
      tier: tier.tier as CheckTier,
      command: tier.command,
      seen: true,
      exitCode,
      isError: Boolean(result?.data.isError) || (exitCode !== null && exitCode !== 0),
    };
  });
}

export function loadChecksFile(worktree: string): CheckRecord[] {
  try {
    return readCheckRecords(readFileSync(path.join(worktree, ".kennel", "checks.jsonl"), "utf8"));
  } catch {
    return [];
  }
}

export function readCheckRecords(text: string): CheckRecord[] {
  const records: CheckRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<CheckRecord>;
      if (!parsed || typeof parsed.tier !== "string") continue;
      records.push({
        tier: parsed.tier,
        ...(typeof parsed.command === "string" ? { command: parsed.command } : {}),
        ...(typeof parsed.exitCode === "number" ? { exitCode: parsed.exitCode } : {}),
        ...(typeof parsed.summary === "string" ? { summary: parsed.summary } : {}),
      });
    } catch {
      // Ignore a half-written line.
    }
  }
  return records;
}

export function pullRequestBody(commitMessage: string, checks: string): string {
  const extra = checks.trim();
  if (!extra) return commitMessage;
  return `${commitMessage}\n\n${extra}`;
}

function resultCell(record: CheckRecord | undefined, observation: CheckObservation | undefined): string {
  if (record && record.exitCode !== undefined && record.exitCode !== null) {
    const summary = record.summary ? ` — ${escapeCell(record.summary)}` : "";
    return `${exitText(record.exitCode)}${summary}`;
  }
  if (!observation?.seen) return "not run";
  if (observation.exitCode !== null) return exitText(observation.exitCode);
  if (observation.isError) return "failed";
  return "ran, result not recorded";
}

function sourceCell(record: CheckRecord | undefined, observation: CheckObservation | undefined): string {
  const sources: string[] = [];
  if (record) sources.push("agent report");
  if (observation?.seen) sources.push("session events");
  return sources.join(", ") || "—";
}

function passed(record: CheckRecord | undefined, observation: CheckObservation | undefined): boolean {
  if (record?.exitCode === 0) return true;
  if (observation?.seen && observation.exitCode === 0 && !observation.isError) return true;
  return false;
}

function exitText(exitCode: number | null | undefined): string {
  if (exitCode === 0) return "passed (exit 0)";
  if (typeof exitCode === "number") return `failed (exit ${exitCode})`;
  return "not run";
}

function commandOf(data: Record<string, unknown>): string | null {
  const input = data.input;
  if (typeof input === "string") return input;
  if (!input || typeof input !== "object") return null;
  const record = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return null;
}

function exitCodeOf(output: unknown): number | null {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? "");
  const match = /exit(?:\s+code)?[:\s]+(\d+)/i.exec(text);
  if (!match?.[1]) return null;
  return Number(match[1]);
}

function normalize(command: string): string {
  return command.replace(/\s+/g, " ").trim();
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function isKnownTier(tier: string): tier is CheckTier {
  return (CHECK_TIERS as readonly string[]).includes(tier);
}
