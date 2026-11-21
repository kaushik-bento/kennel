#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createKennel, logReady } from "./create.js";

export { createKennel, logReady } from "./create.js";
export { loadConfig } from "./config.js";
export type { KennelConfig } from "./config.js";

async function main(): Promise<void> {
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
