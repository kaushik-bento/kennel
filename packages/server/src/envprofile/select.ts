import { hashLockfiles, imageName } from "./hash.js";
import type { EnvProfile, ImageDecision, LockfileSnapshot } from "./types.js";

export interface SelectImageInput {
  fallbackImage: string;
  profile: EnvProfile | null;
  /** Null when the lockfiles could not be read. */
  lockfiles: LockfileSnapshot[] | null;
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
    const reason = `env ${profile.name}: image ${desired} is not published; using ${input.fallbackImage}`;
    log(`[kennel] ${reason}`);
    if (input.rebuild) {
      void input.rebuild(profile, hash, desired).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log(`[kennel] env ${profile.name}: rebuild of ${desired} failed: ${message}`);
      });
    }
    return { image: input.fallbackImage, fallback: true, desired, hash, profile, reason };
  }
  return { image: desired, fallback: false, desired, hash, profile };
}
