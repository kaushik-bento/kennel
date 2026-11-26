import { createHash } from "node:crypto";
import type { EnvProfile, LockfileSnapshot } from "./types.js";

/** Stable id for the lockfiles that are baked into an environment image. */
export function hashLockfiles(files: LockfileSnapshot[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content ?? "");
    hash.update("\0");
    hash.update(file.content === null ? "missing" : "present");
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

export function imageName(profile: EnvProfile, hash: string): string {
  return `kennel-env-${profile.name}-${hash}`;
}
