import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { sandboxEnv } from "../sandbox/modal-host.js";
import { EnvCatalog } from "./catalog.js";
import { countOutput, renderSummary, type TierResult } from "./ci-summary.js";
import { renderSessionScript } from "./image-plan.js";
import { redactSecrets } from "./redact.js";
import type { EnvProfile } from "./types.js";

export interface CiOptions {
  profile: string;
  branch: string;
  base?: string;
  tiers?: string[];
  repo?: string;
  cpu?: number;
  memoryMiB?: number;
  tierTimeoutSeconds?: number;
  logDir?: string;
  out?: string;
}

/**
 * `kennel env ci <profile> --branch <branch>`
 *
 * Runs a profile's CI tiers (the `ci:` list, or --tiers) against one branch
 * in a single Modal sandbox started from the profile's environment image, and
 * prints pass/fail with test, type, and lint counts per tier. This replaces
 * the hosted CI runners for a pull request: nothing runs on GitHub.
 *
 * The sandbox gets the build secret (KENNEL_BUILD_SECRET, a GitHub token for
 * the clone) and KENNEL_MODAL_EXTRA_SECRETS. It never gets the agent secret.
 */
export async function runCi(options: CiOptions): Promise<TierResult[]> {
  const dir = process.env.KENNEL_ENV_DIR || path.resolve(process.cwd(), "environments");
  const dataDir = path.resolve(process.env.KENNEL_DATA_DIR ?? path.join(os.homedir(), ".kennel"));
  const catalog = EnvCatalog.load(dir, dataDir);
  const profile = catalog.get(options.profile);
  if (!profile) throw new Error(`unknown environment profile "${options.profile}" in ${dir}`);
  const tiers = options.tiers && options.tiers.length > 0 ? options.tiers : profile.ci;
  if (tiers.length === 0) throw new Error(`profile ${profile.name} has no ci tiers; pass --tiers`);
  for (const tier of tiers) {
    if (!profile.checks[tier]) throw new Error(`profile ${profile.name} has no check tier "${tier}"`);
  }
  const repo = options.repo ?? profile.repos[0];
  if (!repo) throw new Error(`profile ${profile.name} has no repos`);
  const base = options.base ?? "main";
  const baseImage = process.env.KENNEL_MODAL_IMAGE || "kennel-agent";
  const environment = process.env.KENNEL_MODAL_ENVIRONMENT || process.env.MODAL_ENVIRONMENT;
  const envParams = environment ? { environment } : {};

  const { decision } = await catalog.prepare(repo, {
    fallbackImage: baseImage,
    imageExists: (name) => imageExists(name, envParams),
    log: (line) => console.log(line),
  });
  console.log(`[kennel] ci ${profile.name} ${options.branch}: image ${decision.image}${decision.reason ? ` (${decision.reason})` : ""}`);

  const size = ciSize(profile, tiers, options);
  const { ModalClient } = await import("modal");
  const modal = new ModalClient();
  const app = await modal.apps.fromName(process.env.KENNEL_MODAL_APP || "kennel", { createIfMissing: true, ...envParams });
  const image = await modal.images.fromName(decision.image, envParams);
  const secrets = [];
  const secretNames = [
    ...(process.env.KENNEL_BUILD_SECRET ? [process.env.KENNEL_BUILD_SECRET] : []),
    ...(process.env.KENNEL_MODAL_EXTRA_SECRETS ?? "").split(",").map((name) => name.trim()).filter(Boolean),
  ].filter((name) => name !== (process.env.KENNEL_MODAL_SECRET || "kennel-agent"));
  for (const name of secretNames) {
    try {
      secrets.push(await modal.secrets.fromName(name, envParams));
    } catch {
      console.error(`[kennel] ci: secret ${name} unavailable; continuing without it`);
    }
  }
  const timeoutSeconds = options.tierTimeoutSeconds ?? 45 * 60;
  const sandbox = await modal.sandboxes.create(app, image, {
    secrets,
    cpu: size.cpu,
    memoryMiB: size.memoryMiB,
    memoryLimitMiB: size.memoryMiB,
    timeoutMs: Math.min(24 * 3600_000, (tiers.length * timeoutSeconds + 1800) * 1000),
    env: { ...sandboxEnv({ memoryMiB: size.memoryMiB }), HOME: "/root", ...profile.env },
  });
  console.log(`[kennel] ci sandbox ${sandbox.sandboxId} (${size.cpu} CPU, ${size.memoryMiB} MiB)`);
  const script = ciScript(profile, repo, options.branch, base, tiers, timeoutSeconds);
  const results: TierResult[] = [];
  const logDir = options.logDir ?? path.join(dataDir, "ci", `${profile.name}-${options.branch.replace(/[^\w.-]+/g, "_")}-${Date.now()}`);
  mkdirSync(logDir, { recursive: true });
  try {
    const proc = await sandbox.exec(["bash", "-c", `echo ${Buffer.from(script).toString("base64")} | base64 -d > /tmp/kennel-ci.sh && bash /tmp/kennel-ci.sh`], {
      stdout: "pipe",
      stderr: "pipe",
      mode: "text",
    });
    void (async () => {
      for await (const line of createInterface({ input: Readable.from(proc.stderr) })) console.error(`[ci stderr] ${line}`);
    })();
    let current: { tier: string; lines: string[] } | null = null;
    const prepare: string[] = [];
    for await (const raw of createInterface({ input: Readable.from(proc.stdout) })) {
      const line = redactSecrets(raw);
      const marker = /^KENNEL_CI\t(begin|end)\t([^\t]+)(?:\t(-?\d+)\t(\d+))?$/.exec(line);
      if (marker?.[1] === "begin") {
        current = { tier: marker[2] as string, lines: [] };
        console.log(`[kennel] ci: ${current.tier} ...`);
        continue;
      }
      if (marker?.[1] === "end" && current) {
        const exitCode = Number(marker[3]);
        const text = current.lines.join("\n");
        writeFileSync(path.join(logDir, `${current.tier}.log`), text);
        const status = exitCode === 0 ? "passed" : exitCode === 124 ? "timeout" : exitCode === 200 ? "skipped" : "failed";
        const result: TierResult = {
          tier: current.tier,
          command: profile.checks[current.tier]?.command ?? "",
          status,
          exitCode,
          seconds: Number(marker[4]),
          ...countOutput(text),
          ...(status === "failed" || status === "timeout" ? { tail: current.lines.slice(-40).join("\n") } : {}),
        };
        results.push(result);
        console.log(`[kennel] ci: ${result.tier} ${result.status} in ${result.seconds}s`);
        current = null;
        continue;
      }
      if (current) current.lines.push(line);
      else prepare.push(line);
    }
    writeFileSync(path.join(logDir, "prepare.log"), prepare.join("\n"));
    const code = await proc.wait();
    if (results.length === 0) throw new Error(`ci sandbox exited ${code} before any tier ran; see ${path.join(logDir, "prepare.log")}`);
  } finally {
    await sandbox.terminate().catch(() => undefined);
  }
  console.log(renderSummary(options.branch, results));
  console.log(`[kennel] ci logs: ${logDir}`);
  if (options.out) writeFileSync(options.out, `${JSON.stringify({ profile: profile.name, branch: options.branch, base, image: decision.image, results }, null, 2)}\n`);
  return results;
}

export function ciSize(profile: EnvProfile, tiers: string[], options: { cpu?: number; memoryMiB?: number }): { cpu: number; memoryMiB: number } {
  let cpu = profile.sandbox?.cpu ?? 2;
  let memoryMiB = profile.sandbox?.memoryMiB ?? 4096;
  for (const tier of tiers) {
    cpu = Math.max(cpu, profile.checks[tier]?.cpu ?? 0);
    memoryMiB = Math.max(memoryMiB, profile.checks[tier]?.memoryMiB ?? 0);
  }
  return { cpu: options.cpu ?? cpu, memoryMiB: options.memoryMiB ?? memoryMiB };
}

/** The script the CI sandbox runs. Markers on stdout split the output by tier. */
export function ciScript(profile: EnvProfile, repo: string, branch: string, base: string, tiers: string[], timeoutSeconds: number): string {
  const q = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  const lines = [
    "#!/bin/bash",
    "set -uo pipefail",
    "helper=$(mktemp)",
    "cat > \"$helper\" << 'EOF'",
    "#!/bin/sh",
    "echo username=x-access-token",
    "printf 'password=%s\\n' \"${GITHUB_TOKEN:-${GH_TOKEN:-}}\"",
    "EOF",
    "chmod 700 \"$helper\"",
    "gitc() { git -c \"credential.helper=$helper\" \"$@\"; }",
    "if [ ! -d /opt/kennel-env/src/.git ]; then",
    `  mkdir -p /opt/kennel-env && gitc clone --depth 1 ${q(repo)} /opt/kennel-env/src || exit 90`,
    "fi",
    "cd /opt/kennel-env/src",
    `gitc fetch --depth 200 origin ${q(`+refs/heads/${branch}:refs/remotes/origin/${branch}`)} ${q(`+refs/heads/${base}:refs/remotes/origin/${base}`)} || exit 91`,
    `git checkout -q -f --detach ${q(`origin/${branch}`)} || exit 92`,
    "git clean -q -fd -e node_modules -e .turbo",
    'echo "[kennel] ci at $(git rev-parse HEAD)"',
    "rm -f \"$helper\"",
    "bash /tmp/kennel-session.sh || echo '[kennel] session services did not all start' >&2",
    "failed_install=0",
  ];
  const session = renderSessionScript(profile);
  lines.splice(1, 0, `echo ${Buffer.from(session).toString("base64")} | base64 -d > /tmp/kennel-session.sh`);
  for (const tier of tiers) {
    const command = profile.checks[tier]?.command ?? "true";
    lines.push(
      `printf 'KENNEL_CI\\tbegin\\t%s\\n' ${q(tier)}`,
      "start=$(date +%s)",
      `if [ "$failed_install" = 1 ]; then echo 'skipped: install failed'; rc=200; else timeout --kill-after=30 ${timeoutSeconds} bash -c ${q(command)} < /dev/null 2>&1; rc=$?; fi`,
      ...(tier === "install" ? ['[ "$rc" = 0 ] || failed_install=1'] : []),
      `printf 'KENNEL_CI\\tend\\t%s\\t%s\\t%s\\n' ${q(tier)} "$rc" "$(( $(date +%s) - start ))"`,
    );
  }
  return `${lines.join("\n")}\n`;
}

async function imageExists(name: string, envParams: { environment?: string }): Promise<boolean> {
  const { ModalClient } = await import("modal");
  try {
    await new ModalClient().images.fromName(name, envParams);
    return true;
  } catch {
    return false;
  }
}
