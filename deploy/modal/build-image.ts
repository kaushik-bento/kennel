/**
 * Build and publish the kennel agent image on Modal.
 *
 *   MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... npx tsx deploy/modal/build-image.ts
 *
 * Reads deploy/modal/Dockerfile (the lines after FROM) so there is one image
 * definition. Publishes it as kennel-agent, or $KENNEL_MODAL_IMAGE.
 * The control plane then starts sandboxes from that name. It does not build
 * during session create.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ModalClient } from "modal";

const name = process.env.KENNEL_MODAL_IMAGE || "kennel-agent";
const appName = process.env.KENNEL_MODAL_APP || "kennel";
const repoUrl = process.env.KENNEL_REPO_URL || "https://github.com/kaushik-bento/kennel.git";
const gitRef = process.env.KENNEL_GIT_REF || "main";
// Pin the clone to a commit so Modal's layer cache rebuilds when the ref moves.
const sha =
  process.env.KENNEL_GIT_SHA ||
  execFileSync("git", ["ls-remote", repoUrl, gitRef], { encoding: "utf8" }).trim().split(/\s+/)[0];
if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error(`could not resolve ${gitRef} in ${repoUrl}`);
const dockerfile = readFileSync(path.join(import.meta.dirname, "Dockerfile"), "utf8")
  .replaceAll("@@KENNEL_REPO_URL@@", repoUrl)
  .replaceAll("@@KENNEL_GIT_SHA@@", sha);
const commands = dockerfile
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("FROM "));

const modal = new ModalClient();
const app = await modal.apps.fromName(appName, { createIfMissing: true });
const image = modal.images.fromRegistry("node:22-bookworm").dockerfileCommands(commands);
console.log(`[kennel] building ${commands.length} image steps for ${name} from ${gitRef} (${sha})`);
await image.build(app);
await image.publish(name);
console.log(`[kennel] published image ${name}`);
