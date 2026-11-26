import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { runCommand } from "../exec.js";
import { hashLockfiles, imageName } from "./hash.js";
import { planImage } from "./image-plan.js";
import { checkList, loadProfiles, matchProfile, sessionResources } from "./load.js";
import { selectSessionImage } from "./select.js";
import { renderTestingDoc } from "./testing-doc.js";
import type { EnvProfile, ImageDecision, LockfileSnapshot, SandboxSize } from "./types.js";

export interface SessionEnvironment {
  profile: string;
  image: string;
  fallback: boolean;
  testingDoc: string;
  /** Empty when the profile image is not the one being started. */
  sessionScript: string;
  env: Record<string, string>;
  stripEnv: string[];
  stripPaths: string[];
  checks: Array<{ tier: string; command: string }>;
}

export interface PreparedSession {
  decision: ImageDecision;
  resources: SandboxSize;
  environment: SessionEnvironment | null;
}

export class EnvCatalog {
  constructor(
    readonly profiles: EnvProfile[],
    private readonly cacheDir: string,
  ) {}

  static load(dir: string | undefined, cacheDir: string): EnvCatalog {
    return new EnvCatalog(dir ? loadProfiles(dir) : [], cacheDir);
  }

  match(repo: string): EnvProfile | null {
    return matchProfile(this.profiles, repo);
  }

  get(name: string): EnvProfile | null {
    return this.profiles.find((profile) => profile.name === name) ?? null;
  }

  /**
   * Resolve the image and the instructions for one session.
   * Image lookup and rebuild are injected so tests do not talk to Modal.
   */
  async prepare(
    repo: string,
    options: {
      fallbackImage: string;
      imageExists: (name: string) => Promise<boolean> | boolean;
      /** Host backend: write the testing notes and do not look up a Modal image. */
      skipImage?: boolean;
      rebuild?: (profile: EnvProfile, hash: string, desired: string) => Promise<void>;
      log?: (line: string) => void;
    },
  ): Promise<PreparedSession> {
    const profile = this.match(repo);
    if (options.skipImage) return this.localPlan(profile);
    let lockfiles: LockfileSnapshot[] | null = null;
    let previousLockfiles: LockfileSnapshot[][] = [];
    if (profile) {
      try {
        ({ lockfiles, previous: previousLockfiles } = await this.readLockfileHistory(repo, profile));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        options.log?.(`[kennel] env ${profile.name}: ${message}`);
        lockfiles = null;
      }
    }
    const decision = await selectSessionImage({
      fallbackImage: options.fallbackImage,
      profile,
      lockfiles,
      previousLockfiles,
      imageExists: options.imageExists,
      ...(options.rebuild ? { rebuild: options.rebuild } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
    if (!decision.profile) return { decision, resources: {}, environment: null };
    const script = decision.fallback ? "" : planImage(decision.profile).sessionScript;
    const staleNote = decision.stale
      ? "\n\nThis sandbox image was built for an older lockfile on the default branch. Run the dependency install (for example `bun install --frozen-lockfile`) before tests.\n"
      : "";
    return {
      decision,
      resources: sessionResources(decision.profile),
      environment: {
        profile: decision.profile.name,
        image: decision.image,
        fallback: decision.fallback,
        testingDoc: renderTestingDoc(decision.profile, { fallback: decision.fallback }) + staleNote,
        sessionScript: script,
        env: decision.profile.env,
        stripEnv: decision.profile.stripEnv,
        stripPaths: decision.profile.stripPaths,
        checks: checkList(decision.profile),
      },
    };
  }

  private localPlan(profile: EnvProfile | null): PreparedSession {
    if (!profile) return { decision: { image: "local", fallback: false, profile: null }, resources: {}, environment: null };
    return {
      decision: { image: "local", fallback: false, profile },
      resources: sessionResources(profile),
      environment: {
        profile: profile.name,
        image: "local",
        fallback: false,
        testingDoc: renderTestingDoc(profile, { runtime: "local" }),
        sessionScript: "",
        env: profile.env,
        stripEnv: profile.stripEnv,
        stripPaths: profile.stripPaths,
        checks: checkList(profile),
      },
    };
  }

  async inspect(repo: string, profile: EnvProfile): Promise<{ sha: string; lockfiles: LockfileSnapshot[] }> {
    const dir = await this.ensureClone(repo);
    const rev = await defaultRev(dir);
    const sha = (await runCommand("git", ["-C", dir, "rev-parse", rev])).trim();
    const lockfiles = await showLockfiles(dir, rev, profile.lockfiles);
    return { sha, lockfiles };
  }

  /** Current lockfiles plus up to PREVIOUS_LOCKFILE_REVISIONS older revisions, newest first. */
  private async readLockfileHistory(
    repo: string,
    profile: EnvProfile,
  ): Promise<{ lockfiles: LockfileSnapshot[]; previous: LockfileSnapshot[][] }> {
    if (profile.lockfiles.length === 0) return { lockfiles: [], previous: [] };
    const dir = await this.ensureClone(repo);
    const rev = await defaultRev(dir);
    const lockfiles = await showLockfiles(dir, rev, profile.lockfiles);
    const previous: LockfileSnapshot[][] = [];
    try {
      const log = await runCommand("git", [
        "-C",
        dir,
        "log",
        "--format=%H",
        `-n${PREVIOUS_LOCKFILE_REVISIONS + 1}`,
        rev,
        "--",
        ...profile.lockfiles,
      ]);
      const commits = log.split("\n").map((line) => line.trim()).filter(Boolean);
      for (const commit of commits) {
        const files = await showLockfiles(dir, commit, profile.lockfiles);
        if (hashLockfiles(files) !== hashLockfiles(lockfiles)) previous.push(files);
      }
    } catch {
      // History is only a fallback; a shallow or broken clone still gets the base image.
    }
    return { lockfiles, previous };
  }

  private async ensureClone(repo: string): Promise<string> {
    const digest = createHash("sha256").update(repo).digest("hex").slice(0, 20);
    const dir = path.join(this.cacheDir, "env-src", digest);
    mkdirSync(path.dirname(dir), { recursive: true });
    if (!existsSync(path.join(dir, ".git"))) {
      await runCommand("git", ["clone", "--quiet", repo, dir]);
    }
    await runCommand("git", ["-C", dir, "fetch", "--prune", "origin"]);
    return dir;
  }
}

const PREVIOUS_LOCKFILE_REVISIONS = 8;

async function defaultRev(dir: string): Promise<string> {
  try {
    return (await runCommand("git", ["-C", dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"])).trim();
  } catch {
    return "HEAD";
  }
}

async function showLockfiles(dir: string, rev: string, paths: string[]): Promise<LockfileSnapshot[]> {
  const files: LockfileSnapshot[] = [];
  for (const file of paths) {
    try {
      const content = await runCommand("git", ["-C", dir, "show", `${rev}:${file}`]);
      files.push({ path: file, content });
    } catch {
      files.push({ path: file, content: null });
    }
  }
  return files;
}

export function desiredImage(profile: EnvProfile, lockfiles: LockfileSnapshot[]): string {
  return imageName(profile, hashLockfiles(lockfiles));
}
