import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const IGNORED = ["KENNEL_TESTING.md", ".kennel/"];

/** Drop the testing notes into the worktree without letting them into a commit. */
export function installTestingDoc(worktree: string, doc: string): void {
  writeFileSync(path.join(worktree, "KENNEL_TESTING.md"), doc);
  mkdirSync(path.join(worktree, ".kennel"), { recursive: true });
  ignoreKennelFiles(worktree);
}

export function ignoreKennelFiles(worktree: string): void {
  try {
    const exclude = execFileSync("git", ["-C", worktree, "rev-parse", "--git-path", "info/exclude"], {
      encoding: "utf8",
    }).trim();
    const file = path.resolve(worktree, exclude);
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `\n# kennel\n${IGNORED.join("\n")}\n`);
  } catch {
    // The worktree can still be used. finish also unstages these paths.
  }
}
