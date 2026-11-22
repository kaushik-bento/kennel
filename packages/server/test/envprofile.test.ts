import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { loadChecksFile, renderCheckReport } from "../src/envprofile/checks.js";
import { hashLockfiles, imageName } from "../src/envprofile/hash.js";
import { planImage } from "../src/envprofile/image-plan.js";
import { loadProfiles, matchProfile, repoKey } from "../src/envprofile/load.js";
import { selectSessionImage } from "../src/envprofile/select.js";
import { renderTestingDoc } from "../src/envprofile/testing-doc.js";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

const profilesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../environments");

describe("environment profiles", () => {
  test("matches a repo URL across https, ssh, and .git forms", () => {
    const profiles = loadProfiles(profilesDir);
    const profile = matchProfile(profiles, "git@github.com:example/app.git");
    assert.equal(profile?.name, "example");
    assert.equal(repoKey("https://github.com/example/app"), repoKey("ssh://git@github.com/example/app.git"));
    assert.equal(matchProfile(profiles, "https://github.com/example/other"), null);
  });

  test("names the image from the lockfile hash and rebuilds when the hash changes", async () => {
    const profile = matchProfile(loadProfiles(profilesDir), "https://github.com/example/app");
    assert.ok(profile);
    const first = hashLockfiles([{ path: "package-lock.json", content: "lock-a" }]);
    const second = hashLockfiles([{ path: "package-lock.json", content: "lock-b" }]);
    assert.notEqual(first, second);
    assert.equal(imageName(profile, first), `kennel-env-example-${first}`);
    const built: string[] = [];
    const missing = await selectSessionImage({
      fallbackImage: "kennel-agent",
      profile,
      lockfiles: [{ path: "package-lock.json", content: "lock-a" }],
      imageExists: () => false,
      rebuild: async (_profile, _hash, desired) => {
        built.push(desired);
      },
      log: () => undefined,
    });
    assert.equal(missing.image, "kennel-agent");
    assert.equal(missing.fallback, true);
    assert.equal(missing.desired, imageName(profile, first));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(built, [missing.desired]);

    const present = await selectSessionImage({
      fallbackImage: "kennel-agent",
      profile,
      lockfiles: [{ path: "package-lock.json", content: "lock-b" }],
      imageExists: (name) => name === imageName(profile, second),
      rebuild: async () => {
        throw new Error("should not rebuild");
      },
      log: () => undefined,
    });
    assert.equal(present.fallback, false);
    assert.equal(present.image, imageName(profile, second));
  });

  test("falls back when the image lookup fails and does not throw", async () => {
    const profile = matchProfile(loadProfiles(profilesDir), "https://github.com/example/app");
    assert.ok(profile);
    const lines: string[] = [];
    const decision = await selectSessionImage({
      fallbackImage: "kennel-agent",
      profile,
      lockfiles: [{ path: "package-lock.json", content: null }],
      imageExists: () => {
        throw new Error("modal down");
      },
      log: (line) => lines.push(line),
    });
    assert.equal(decision.image, "kennel-agent");
    assert.equal(decision.fallback, true);
    assert.match(lines.join("\n"), /using kennel-agent/);
    const unread = await selectSessionImage({
      fallbackImage: "kennel-agent",
      profile,
      lockfiles: null,
      imageExists: () => true,
      log: () => undefined,
    });
    assert.equal(unread.fallback, true);
    assert.equal(unread.desired, undefined);
  });

  test("bakes setup and a database snapshot into the image plan", () => {
    const profile = matchProfile(loadProfiles(profilesDir), "https://github.com/example/app");
    assert.ok(profile);
    const plan = planImage(profile);
    assert.match(plan.commands.join("\n"), /base64 -d \| bash/);
    assert.match(plan.setupScript, /npm ci/);
    assert.match(plan.setupScript, /npm run db:migrate/);
    assert.match(plan.setupScript, /pg-snapshot/);
    assert.match(plan.setupScript, /CREATE EXTENSION IF NOT EXISTS vector/);
    assert.match(plan.setupScript, /ALTER USER postgres PASSWORD 'postgres'/);
    assert.doesNotMatch(plan.setupScript, /ghp_|AKIA/);
    assert.match(plan.sessionScript, /\/var\/kennel\/pgdata/);
    assert.match(plan.sessionScript, /redis-server/);
  });

  test("tells the agent how to run each tier and records check results", () => {
    const profile = matchProfile(loadProfiles(profilesDir), "https://github.com/example/app");
    assert.ok(profile);
    const doc = renderTestingDoc(profile);
    assert.match(doc, /not done until the `fast` checks/);
    assert.match(doc, /npm test -- --changed/);
    assert.match(doc, /Do not deploy this app/);
    assert.match(doc, /only database is the local one/);
    const report = renderCheckReport({
      tiers: [
        { tier: "fast", command: "npm test" },
        { tier: "targeted", command: "npm test -- --changed" },
      ],
      events: [
        { type: "tool_call", data: { toolUseId: "1", name: "Bash", input: { command: "npm test" } } },
        { type: "tool_result", data: { toolUseId: "1", output: "exit code 0", isError: false } },
      ],
      records: [{ tier: "targeted", command: "npm test -- --changed", exitCode: 1, summary: "one failed" }],
    });
    assert.match(report, /fast \| passed/);
    assert.match(report, /targeted \| failed \(exit 1\)/);
    assert.match(report, /Required checks not recorded as passed: `targeted`/);
    const dir = mkdtempSync(path.join(tmpdir(), "kennel-checks-"));
    mkdirSync(path.join(dir, ".kennel"));
    writeFileSync(path.join(dir, ".kennel", "checks.jsonl"), '{"tier":"fast","exitCode":0}\nnot json\n');
    assert.equal(loadChecksFile(dir)[0]?.exitCode, 0);
  });
});
