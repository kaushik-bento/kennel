import os from "node:os";
import path from "node:path";
import { EnvCatalog } from "./catalog.js";
import { publishEnvironmentImage } from "./build.js";
import { hashLockfiles, imageName } from "./hash.js";

/**
 * `kennel env build <profile>`
 *
 * Reads profiles from KENNEL_ENV_DIR (or ./environments), hashes the lockfiles
 * on the default branch, and publishes kennel-env-<profile>-<hash>.
 * Modal credentials and a GitHub token that can read the repo must be available
 * to this process. The token is passed to the image build as a Modal Secret
 * (`KENNEL_MODAL_SECRET`, default kennel-agent) and is not printed.
 */
export async function buildProfileCommand(name: string): Promise<void> {
  if (!name) throw new Error("usage: kennel env build <profile>");
  const dir = process.env.KENNEL_ENV_DIR || path.resolve(process.cwd(), "environments");
  const dataDir = path.resolve(process.env.KENNEL_DATA_DIR ?? path.join(os.homedir(), ".kennel"));
  const catalog = EnvCatalog.load(dir, dataDir);
  const profile = catalog.get(name);
  if (!profile) throw new Error(`unknown environment profile "${name}" in ${dir}`);
  const repo = profile.repos[0];
  if (!repo) throw new Error(`profile ${name} has no repos`);
  const inspected = await catalog.inspect(repo, profile);
  const hash = hashLockfiles(inspected.lockfiles);
  const tag = imageName(profile, hash);
  console.log(`[kennel] ${name} lockfile hash ${hash} at ${inspected.sha}`);
  const environment = process.env.KENNEL_MODAL_ENVIRONMENT || process.env.MODAL_ENVIRONMENT;
  await publishEnvironmentImage({
    profile,
    repoUrl: repo,
    gitSha: inspected.sha,
    imageName: tag,
    appName: process.env.KENNEL_MODAL_APP || "kennel",
    secretName: process.env.KENNEL_MODAL_SECRET || "kennel-agent",
    baseImage: process.env.KENNEL_MODAL_IMAGE || "kennel-agent",
    ...(environment ? { environment } : {}),
  });
}
