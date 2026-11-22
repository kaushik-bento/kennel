import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { loadChecksFile, pullRequestBody, renderCheckReport } from "./envprofile/checks.js";
import type { CheckTier } from "./envprofile/types.js";
import { KennelError } from "./errors.js";
import { runCommand } from "./exec.js";

export interface PreparedWorktree {
  sourcePath: string;
  worktreePath: string;
  branch: string;
}

const fetches = new Map<string, Promise<void>>();

async function git(args: string[], status = 500): Promise<string> {
  return runCommand("git", args, { status });
}

function isLocalRepo(repo: string): boolean {
  const resolved = path.resolve(repo);
  return existsSync(resolved) && existsSync(path.join(resolved, ".git"));
}

export class GitWorkspace {
  constructor(private readonly dataDir: string) {}

  /** Create the worktree, or return it when this volume was already bootstrapped. */
  async ensure(input: { repo: string; baseBranch: string; branch: string; sessionId: string }): Promise<PreparedWorktree> {
    const local = isLocalRepo(input.repo);
    const sourcePath = local ? path.resolve(input.repo) : await this.cachedClone(input.repo);
    const worktreePath = path.join(this.dataDir, "worktrees", input.sessionId);
    if (existsSync(path.join(worktreePath, ".git"))) {
      return { sourcePath, worktreePath, branch: input.branch };
    }
    return this.prepare(input);
  }

  async prepare(input: { repo: string; baseBranch: string; branch: string; sessionId: string }): Promise<PreparedWorktree> {
    const local = isLocalRepo(input.repo);
    const sourcePath = local ? path.resolve(input.repo) : await this.cachedClone(input.repo);
    if (local) {
      await git(["-C", sourcePath, "fetch", "--prune", "origin"]).catch(() => "");
    }
    const ref = await this.resolveRef(sourcePath, input.baseBranch, !local);
    const worktreePath = path.join(this.dataDir, "worktrees", input.sessionId);
    mkdirSync(path.dirname(worktreePath), { recursive: true });
    await git(["-C", sourcePath, "worktree", "add", "-b", input.branch, worktreePath, ref], 400);
    return { sourcePath, worktreePath, branch: input.branch };
  }

  async remove(sourcePath: string, worktreePath: string, branch: string): Promise<void> {
    if (existsSync(worktreePath)) {
      await git(["-C", sourcePath, "worktree", "remove", "--force", worktreePath]).catch(async () => {
        await git(["-C", sourcePath, "worktree", "prune"]);
      });
    } else {
      await git(["-C", sourcePath, "worktree", "prune"]).catch(() => "");
    }
    await git(["-C", sourcePath, "branch", "-D", branch]).catch(() => "");
  }

  async finish(input: {
    worktreePath: string;
    branch: string;
    baseBranch: string;
    commitMessage: string;
    openPr: boolean;
    repo: string;
    checks?: {
      tiers: Array<{ tier: string; command: string }>;
      events: Array<{ type: string; data: Record<string, unknown> }>;
    };
  }): Promise<{ committed: boolean; commit: string | null; pushed: boolean; prUrl: string | null; prError: string | null }> {
    const porcelain = (await git(["-C", input.worktreePath, "status", "--porcelain"])).trim();
    let committed = false;
    let commit: string | null = null;
    if (porcelain) {
      await git(["-C", input.worktreePath, "add", "-A"]);
      await git(["-C", input.worktreePath, "reset", "-q", "--", "KENNEL_TESTING.md", ".kennel"]).catch(() => "");
      const staged = (await git(["-C", input.worktreePath, "diff", "--cached", "--name-only"])).trim();
      if (staged) {
        await git([
          "-C",
          input.worktreePath,
          "-c",
          "user.email=kennel@localhost",
          "-c",
          "user.name=kennel",
          "commit",
          "-m",
          input.commitMessage,
        ]);
        committed = true;
      }
    }
    const head = (await git(["-C", input.worktreePath, "rev-parse", "HEAD"])).trim();
    commit = head || null;
    const body = pullRequestBody(input.commitMessage, checksSection(input));
    await git(["-C", input.worktreePath, "push", "-u", "origin", input.branch]);
    if (!input.openPr) {
      return { committed, commit, pushed: true, prUrl: null, prError: null };
    }
    const gh = await ghAvailable();
    if (!gh) {
      return { committed, commit, pushed: true, prUrl: null, prError: "gh is not installed" };
    }
    try {
      const url = (
        await runCommand("gh", [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.branch,
          "--title",
          input.commitMessage,
          "--body",
          body,
        ], { cwd: input.worktreePath })
      ).trim();
      return { committed, commit, pushed: true, prUrl: url || null, prError: null };
    } catch (err) {
      try {
        const existing = (
          await runCommand("gh", ["pr", "view", "--json", "url", "--jq", ".url"], { cwd: input.worktreePath })
        ).trim();
        if (existing) return { committed, commit, pushed: true, prUrl: existing, prError: null };
      } catch {
        // fall through to the original error
      }
      const message = err instanceof Error ? err.message : String(err);
      return { committed, commit, pushed: true, prUrl: null, prError: message };
    }
  }

  private async cachedClone(repo: string): Promise<string> {
    const digest = createHash("sha256").update(repo).digest("hex").slice(0, 20);
    const dir = path.join(this.dataDir, "cache", digest);
    mkdirSync(path.dirname(dir), { recursive: true });
    if (!existsSync(path.join(dir, ".git"))) {
      await git(["clone", "--quiet", repo, dir], 400);
    }
    const previous = fetches.get(dir) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => git(["-C", dir, "fetch", "--prune", "origin"], 400).then(() => undefined));
    fetches.set(dir, next);
    await next;
    return dir;
  }

  private async resolveRef(repoDir: string, baseBranch: string, preferOrigin: boolean): Promise<string> {
    const candidates = preferOrigin ? [`origin/${baseBranch}`, baseBranch] : [baseBranch, `origin/${baseBranch}`];
    for (const ref of candidates) {
      try {
        await git(["-C", repoDir, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], 400);
        return ref;
      } catch {
        // try the next candidate
      }
    }
    throw new KennelError(400, `base branch not found: ${baseBranch}`);
  }
}

function checksSection(input: {
  worktreePath: string;
  checks?: {
    tiers: Array<{ tier: string; command: string }>;
    events: Array<{ type: string; data: Record<string, unknown> }>;
  };
}): string {
  if (!input.checks || input.checks.tiers.length === 0) return "";
  return renderCheckReport({
    tiers: input.checks.tiers.map((tier) => ({ tier: tier.tier as CheckTier, command: tier.command })),
    events: input.checks.events,
    records: loadChecksFile(input.worktreePath),
  });
}

async function ghAvailable(): Promise<boolean> {
  try {
    await runCommand("gh", ["--version"]);
    return true;
  } catch {
    return false;
  }
}
