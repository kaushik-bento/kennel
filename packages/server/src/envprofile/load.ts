import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { DEFAULT_CHECK_TIERS, type CheckSpec, type EnvProfile, type SandboxSize } from "./types.js";

const tierName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/);

const checkSchema = z
  .object({
    command: z.string().min(1),
    cpu: z.number().positive().optional(),
    memoryMiB: z.number().int().positive().optional(),
    default: z.boolean().optional(),
  })
  .strict();

const profileSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),
    description: z.string().optional(),
    repos: z.array(z.string().min(1)).min(1),
    apt: z.array(z.string().min(1)).optional(),
    preBuild: z.array(z.string().min(1)).optional(),
    runtimes: z
      .array(
        z
          .object({
            name: z.enum(["node", "bun", "python", "uv", "pnpm"]),
            version: z.string().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
    services: z
      .array(
        z
          .object({
            kind: z.enum(["postgres", "redis"]),
            version: z.string().min(1),
            extensions: z.array(z.string().min(1)).optional(),
            databases: z.array(z.string().min(1)).optional(),
            port: z.number().int().positive().optional(),
            user: z.string().min(1).optional(),
            password: z.string().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
    setup: z.array(z.string().min(1)).optional(),
    env: z.record(z.string(), z.string()).optional(),
    checks: z.record(tierName, checkSchema).optional(),
    ci: z.array(tierName).optional(),
    cache: z.array(z.string().min(1)).optional(),
    lockfiles: z.array(z.string().min(1)).optional(),
    deny: z.array(z.string().min(1)).optional(),
    stripEnv: z.array(z.string().min(1)).optional(),
    stripPaths: z.array(z.string().min(1)).optional(),
    notes: z.array(z.string().min(1)).optional(),
    sandbox: z
      .object({
        cpu: z.number().positive().optional(),
        memoryMiB: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export function parseProfile(text: string, source: string): EnvProfile {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${source}: ${message}`);
  }
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${source}: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "profile"}: ${issue.message}`).join("; ")}`);
  }
  const value = parsed.data;
  for (const tier of value.ci ?? []) {
    if (!value.checks?.[tier]) throw new Error(`${source}: ci: tier "${tier}" is not in checks`);
  }
  return {
    name: value.name,
    ...(value.description ? { description: value.description } : {}),
    repos: value.repos,
    apt: value.apt ?? [],
    preBuild: value.preBuild ?? [],
    runtimes: value.runtimes ?? [],
    services: value.services ?? [],
    setup: value.setup ?? [],
    env: value.env ?? {},
    checks: resolveChecks(value.checks ?? {}),
    ci: value.ci ?? [],
    cache: value.cache ?? [],
    lockfiles: value.lockfiles ?? [],
    deny: value.deny ?? [],
    stripEnv: value.stripEnv ?? [],
    stripPaths: value.stripPaths ?? [],
    notes: value.notes ?? [],
    ...(value.sandbox ? { sandbox: value.sandbox } : {}),
  };
}

export function loadProfiles(dir: string, log: (line: string) => void = (line) => console.error(line)): EnvProfile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const profiles: EnvProfile[] = [];
  const seen = new Set<string>();
  for (const name of names.sort()) {
    if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
    const file = path.join(dir, name);
    if (!statSync(file).isFile()) continue;
    try {
      const profile = parseProfile(readFileSync(file, "utf8"), file);
      if (seen.has(profile.name)) {
        log(`[kennel] skipping environment profile ${file}: duplicate name ${profile.name}`);
        continue;
      }
      seen.add(profile.name);
      profiles.push(profile);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[kennel] skipping environment profile ${file}: ${message}`);
    }
  }
  return profiles;
}

function resolveChecks(raw: Record<string, { command: string; cpu?: number; memoryMiB?: number; default?: boolean }>): Record<string, CheckSpec> {
  const checks: Record<string, CheckSpec> = {};
  for (const [name, check] of Object.entries(raw)) {
    const implied = (DEFAULT_CHECK_TIERS as readonly string[]).includes(name);
    checks[name] = {
      command: check.command,
      ...(check.cpu !== undefined ? { cpu: check.cpu } : {}),
      ...(check.memoryMiB !== undefined ? { memoryMiB: check.memoryMiB } : {}),
      default: check.default ?? implied,
    };
  }
  return checks;
}

/** Compare repository URLs without the scheme, user, or `.git` suffix. */
export function repoKey(repo: string): string {
  let value = repo.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  value = value.replace(/^git@([^:]+):/i, "https://$1/");
  value = value.replace(/^ssh:\/\/(?:git@)?([^/]+)\//i, "https://$1/");
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  value = value.replace(/^[^@/]+@/, "");
  return value.toLowerCase();
}

export function matchProfile(profiles: EnvProfile[], repo: string): EnvProfile | null {
  const key = repoKey(repo);
  return profiles.find((profile) => profile.repos.some((candidate) => repoKey(candidate) === key)) ?? null;
}

export function sessionResources(profile: EnvProfile): SandboxSize {
  if (profile.sandbox?.cpu || profile.sandbox?.memoryMiB) return profile.sandbox;
  const defaults = Object.values(profile.checks).filter((check) => check.default);
  const tiers = defaults.length > 0 ? defaults : Object.values(profile.checks);
  const cpu = tiers.reduce((max, check) => Math.max(max, check.cpu ?? 0), 0);
  const memoryMiB = tiers.reduce((max, check) => Math.max(max, check.memoryMiB ?? 0), 0);
  const size: SandboxSize = {};
  if (cpu > 0) size.cpu = cpu;
  if (memoryMiB > 0) size.memoryMiB = memoryMiB;
  return size;
}

export function checkList(profile: EnvProfile): Array<{ tier: string; command: string; required: boolean }> {
  return Object.entries(profile.checks).map(([tier, check]) => ({
    tier,
    command: check.command,
    required: check.default,
  }));
}
