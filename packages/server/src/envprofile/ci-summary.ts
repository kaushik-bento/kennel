/** Counts pulled out of one check tier's output. Absent means the tool did not report it. */
export interface TierCounts {
  testsPassed?: number;
  testsFailed?: number;
  testsSkipped?: number;
  typeErrors?: number;
  lintErrors?: number;
}

export interface TierResult extends TierCounts {
  tier: string;
  command: string;
  status: "passed" | "failed" | "timeout" | "skipped";
  exitCode: number | null;
  seconds: number;
  /** Last lines of output, for a failure. */
  tail?: string;
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Sum the test, type, and lint counts printed by vitest, bun test, tsc, and
 * biome. Turbo prefixes every line with `<package>:<task>: `, so each summary
 * line is matched anywhere in the line and the per-package numbers add up.
 */
export function countOutput(text: string): TierCounts {
  const counts: TierCounts = {};
  const add = (key: keyof TierCounts, value: number) => {
    counts[key] = (counts[key] ?? 0) + value;
  };
  for (const raw of text.split("\n")) {
    const line = raw.replace(ANSI, "");
    // vitest: " Tests  2 failed | 118 passed | 3 skipped (123)"
    const vitest = /\bTests\s+((?:\d+\s+\w+(?:\s*\|\s*)?)+)\s*\(\d+\)/.exec(line);
    if (vitest?.[1]) {
      for (const part of vitest[1].split("|")) {
        const match = /(\d+)\s+(\w+)/.exec(part.trim());
        if (!match) continue;
        const value = Number(match[1]);
        if (match[2] === "passed") add("testsPassed", value);
        else if (match[2] === "failed") add("testsFailed", value);
        else if (match[2] === "skipped" || match[2] === "todo") add("testsSkipped", value);
      }
      continue;
    }
    // bun test: " 42 pass" / " 1 fail" / " 3 skip" on their own lines
    const bun = /^(?:[\w@/.-]+:[\w:-]+:\s*)?\s*(\d+)\s+(pass|fail|skip)\s*$/.exec(line);
    if (bun) {
      const value = Number(bun[1]);
      if (bun[2] === "pass") add("testsPassed", value);
      else if (bun[2] === "fail") add("testsFailed", value);
      else add("testsSkipped", value);
      continue;
    }
    if (/\berror TS\d+:/.test(line)) add("typeErrors", 1);
    const biome = /Found (\d+) errors?\b/.exec(line);
    if (biome) add("lintErrors", Number(biome[1]));
  }
  return counts;
}

export function renderSummary(branch: string, results: TierResult[]): string {
  const lines = [`kennel ci: ${branch}`];
  for (const result of results) {
    const parts: string[] = [];
    if (result.testsPassed !== undefined || result.testsFailed !== undefined) {
      parts.push(`tests ${result.testsPassed ?? 0} passed, ${result.testsFailed ?? 0} failed${result.testsSkipped ? `, ${result.testsSkipped} skipped` : ""}`);
    }
    if (result.typeErrors !== undefined) parts.push(`${result.typeErrors} type errors`);
    if (result.lintErrors !== undefined) parts.push(`${result.lintErrors} lint errors`);
    const detail = parts.length > 0 ? ` (${parts.join("; ")})` : "";
    lines.push(`  ${result.status.toUpperCase().padEnd(7)} ${result.tier.padEnd(14)} ${Math.round(result.seconds)}s${detail}`);
  }
  const passed = results.filter((result) => result.status === "passed").length;
  lines.push(`  ${passed}/${results.length} tiers passed`);
  return lines.join("\n");
}
