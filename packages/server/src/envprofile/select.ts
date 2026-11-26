import { hashLockfiles, imageName } from "./hash.js";
import type { EnvProfile, ImageDecision, LockfileSnapshot } from "./types.js";

export interface SelectImageInput {
  fallbackImage: string;
  profile: EnvProfile | null;
  /** Null when the lockfiles could not be read. */
  lockfiles: LockfileSnapshot[] | null;
  /** Older revisions of the same lockfiles, newest first. Tried when the exact image is missing. */
  previousLockfiles?: LockfileSnapshot[][];
  imageExists: (name: string) => Promise<boolean> | boolean;
  /** Start a build for the desired tag. Must not be awaited by the caller of selectSessionImage. */
  rebuild?: (profile: EnvProfile, hash: string, desired: string) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * Pick the sandbox image. A missing or failed profile image falls back to the
 * base agent image and optionally starts a rebuild. The session is not blocked.
 */
export async function selectSessionImage(input: SelectImageInput): Promise<ImageDecision> {
  const log = input.log ?? ((line) => console.error(line));
  if (!input.profile) return { image: input.fallbackImage, fallback: false, profile: null };
  const profile = input.profile;
  if (!input.lockfiles) {
    const reason = `env ${profile.name}: could not read lockfiles; using ${input.fallbackImage}`;
    log(`[kennel] ${reason}`);
    return { image: input.fallbackImage, fallback: true, profile, reason };
  }
  const hash = hashLockfiles(input.lockfiles);
  const desired = imageName(profile, hash);
  let exists = false;
  try {
    exists = await input.imageExists(desired);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = `env ${profile.name}: image lookup failed (${message}); using ${input.fallbackImage}`;
    log(`[kennel] ${reason}`);
    return { image: input.fallbackImage, fallback: true, desired, hash, profile, reason };
  }
  if (!exists) {
    if (input.rebuild) {
      void input.rebuild(profile, hash, desired).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log(`[kennel] env ${profile.name}: rebuild of ${desired} failed: ${message}`);
      });
    }
    // A lockfile bump on the default branch should not drop the session to the
    // bare base image (no bun, no Postgres). Use the newest image built for an
    // earlier lockfile revision; the agent reinstalls dependencies.
    for (const older of input.previousLockfiles ?? []) {
      const olderName = imageName(profile, hashLockfiles(older));
      if (olderName === desired) continue;
      let found = false;
      try {
        found = await input.imageExists(olderName);
      } catch {
        found = false;
      }
      if (found) {
        const reason = `env ${profile.name}: image ${desired} is not published; using ${olderName} built for an earlier lockfile`;
        log(`[kennel] ${reason}`);
        return { image: olderName, fallback: false, stale: true, desired, hash, profile, reason };
      }
    }
    const reason = `env ${profile.name}: image ${desired} is not published; using ${input.fallbackImage}`;
    log(`[kennel] ${reason}`);
    return { image: input.fallbackImage, fallback: true, desired, hash, profile, reason };
  }
  return { image: desired, fallback: false, desired, hash, profile };
}
