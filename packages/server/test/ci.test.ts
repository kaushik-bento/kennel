import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ciScript, ciSize } from "../src/envprofile/ci.js";
import { countOutput, renderSummary } from "../src/envprofile/ci-summary.js";
import { parseProfile } from "../src/envprofile/load.js";

const profile = parseProfile(
  [
    "name: citest",
    "repos: [https://github.com/example/ci]",
    "checks:",
    "  install: { command: bun install --frozen-lockfile }",
    "  unit: { command: \"bunx turbo run test\", cpu: 16, memoryMiB: 32768 }",
    "  build: { command: bun run build, memoryMiB: 65536 }",
    "ci: [install, unit, build]",
    "sandbox: { cpu: 8, memoryMiB: 16384 }",
  ].join("\n"),
  "citest.yaml",
);

describe("kennel env ci", () => {
  it("sums vitest, bun test, tsc, and biome counts across turbo packages", () => {
    const output = [
      "@sim/app:test:  Test Files  3 failed | 40 passed (43)",
      "@sim/app:test:       Tests  10 failed | 1200 passed | 4 skipped (1214)",
      "@sim/db:test: \u001b[32m     Tests  \u001b[39m 15 passed (15)",
      " 7 pass",
      " 1 fail",
      "apps/sim/lib/a.ts(3,1): error TS2322: Type 'x' is not assignable",
      "@sim/app:type-check: lib/b.ts(9,2): error TS2304: Cannot find name 'y'.",
      "Found 2 errors.",
    ].join("\n");
    assert.deepEqual(countOutput(output), { testsFailed: 11, testsPassed: 1222, testsSkipped: 4, typeErrors: 2, lintErrors: 2 });
    assert.deepEqual(countOutput("all good"), {});
  });

  it("rejects a ci list naming a tier that does not exist", () => {
    assert.throws(
      () => parseProfile(["name: bad", "repos: [https://github.com/example/bad]", "checks:", "  a: { command: 'true' }", "ci: [a, b]"].join("\n"), "bad.yaml"),
      /tier "b" is not in checks/,
    );
  });

  it("sizes the sandbox for the largest tier and skips the rest after a failed install", () => {
    assert.deepEqual(ciSize(profile, profile.ci, {}), { cpu: 16, memoryMiB: 65536 });
    assert.deepEqual(ciSize(profile, ["install"], {}), { cpu: 8, memoryMiB: 16384 });
    assert.deepEqual(ciSize(profile, ["unit"], { memoryMiB: 49152 }), { cpu: 16, memoryMiB: 49152 });
    const script = ciScript(profile, "https://github.com/example/ci", "fix/ci-thing", "main", profile.ci, 600);
    assert.match(script, /refs\/heads\/fix\/ci-thing:refs\/remotes\/origin\/fix\/ci-thing/);
    assert.match(script, /\[ "\$rc" = 0 \] \|\| failed_install=1/);
    assert.equal((script.match(/KENNEL_CI\\tbegin/g) ?? []).length, 3);
    assert.doesNotMatch(script, /x-access-token:/);
  });

  it("renders a one-line-per-tier summary with counts", () => {
    const text = renderSummary("fix/x", [
      { tier: "unit", command: "t", status: "failed", exitCode: 1, seconds: 61.2, testsPassed: 5, testsFailed: 2 },
      { tier: "type-check", command: "c", status: "passed", exitCode: 0, seconds: 300, typeErrors: 0 },
    ]);
    assert.match(text, /FAILED\s+unit\s+61s \(tests 5 passed, 2 failed\)/);
    assert.match(text, /1\/2 tiers passed/);
  });
});
