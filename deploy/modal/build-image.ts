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
import { readFileSync } from "node:fs";
import path from "node:path";
import { ModalClient } from "modal";

const name = process.env.KENNEL_MODAL_IMAGE || "kennel-agent";
const appName = process.env.KENNEL_MODAL_APP || "kennel";
const dockerfile = readFileSync(path.join(import.meta.dirname, "Dockerfile"), "utf8");
const commands = dockerfile
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("FROM "));

const modal = new ModalClient();
const app = await modal.apps.fromName(appName, { createIfMissing: true });
const image = modal.images.fromRegistry("node:22-bookworm").dockerfileCommands(commands);
console.log(`[kennel] building ${commands.length} image steps for ${name}`);
await image.build(app);
await image.publish(name);
console.log(`[kennel] published image ${name}`);
