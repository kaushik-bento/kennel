#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { buildAdapters } from "./adapters/index.js";
import { prepareHome, serveRunner } from "./runner/serve.js";

export { serveRunner } from "./runner/serve.js";

async function main(): Promise<void> {
  prepareHome(process.env);
  const adapters = buildAdapters({
    codexBin: process.env.KENNEL_CODEX_BIN || "codex",
    echoDelayMs: process.env.KENNEL_ECHO_DELAY_MS ? Number(process.env.KENNEL_ECHO_DELAY_MS) : 5,
  });
  await serveRunner({ input: process.stdin, output: process.stdout }, adapters);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error("[kennel-runner]", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
