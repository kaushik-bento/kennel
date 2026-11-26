#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createKennel, logReady } from "./create.js";

export { createKennel, logReady } from "./create.js";
export { loadConfig } from "./config.js";
export type { KennelConfig } from "./config.js";

async function main(): Promise<void> {
  if (process.argv[2] === "env" && process.argv[3] === "build") {
    const { buildProfileCommand } = await import("./envprofile/cli.js");
    await buildProfileCommand(process.argv[4] ?? "");
    return;
  }
  if (process.argv[2] === "env" && process.argv[3] === "ci") {
    const { parseArgs } = await import("node:util");
    const { runCi } = await import("./envprofile/ci.js");
    const { values, positionals } = parseArgs({
      args: process.argv.slice(4),
      allowPositionals: true,
      options: {
        branch: { type: "string" },
        base: { type: "string" },
        tiers: { type: "string" },
        repo: { type: "string" },
        cpu: { type: "string" },
        memory: { type: "string" },
        timeout: { type: "string" },
        out: { type: "string" },
        "log-dir": { type: "string" },
      },
    });
    if (!positionals[0] || !values.branch) throw new Error("usage: kennel env ci <profile> --branch <branch> [--base main] [--tiers a,b] [--cpu N] [--memory MiB] [--timeout seconds] [--out result.json]");
    const results = await runCi({
      profile: positionals[0],
      branch: values.branch,
      ...(values.base ? { base: values.base } : {}),
      ...(values.tiers ? { tiers: values.tiers.split(",").map((tier) => tier.trim()).filter(Boolean) } : {}),
      ...(values.repo ? { repo: values.repo } : {}),
      ...(values.cpu ? { cpu: Number(values.cpu) } : {}),
      ...(values.memory ? { memoryMiB: Number(values.memory) } : {}),
      ...(values.timeout ? { tierTimeoutSeconds: Number(values.timeout) } : {}),
      ...(values.out ? { out: values.out } : {}),
      ...(values["log-dir"] ? { logDir: values["log-dir"] } : {}),
    });
    process.exitCode = results.every((result) => result.status === "passed") ? 0 : 1;
    return;
  }
  const app = await createKennel();
  await new Promise<void>((resolve, reject) => {
    app.server.once("error", reject);
    app.server.listen(app.config.port, app.config.host, () => {
      app.server.off("error", reject);
      resolve();
    });
  });
  logReady(app.config);
  const shutdown = () => {
    void app.close().then(() => process.exit(0), () => process.exit(1));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error("[kennel]", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
