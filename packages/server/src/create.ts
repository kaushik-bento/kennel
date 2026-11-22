import type { Server } from "node:http";
import { connectorLine, claudeAuthWarning, describeClaudeAuth } from "@kennel/core";
import { buildAdapters, type AdapterOverrides } from "./adapters/index.js";
import { loadConfig, type KennelConfig } from "./config.js";
import { KennelDb } from "./db.js";
import { createHttpServer } from "./http.js";
import { SessionManager } from "./manager.js";
import { createSandboxBackend } from "./sandbox/index.js";
import type { ModalHost } from "./sandbox/types.js";
import { mkdirSync } from "node:fs";
import path from "node:path";

export interface KennelApp {
  config: KennelConfig;
  manager: SessionManager;
  server: Server;
  close(): Promise<void>;
}

export async function createKennel(options?: {
  env?: NodeJS.ProcessEnv;
  config?: KennelConfig;
  adapters?: AdapterOverrides;
  modalHost?: ModalHost;
}): Promise<KennelApp> {
  const config = options?.config ?? loadConfig(options?.env ?? process.env);
  mkdirSync(config.dataDir, { recursive: true });
  const db = KennelDb.open(path.join(config.dataDir, "kennel.sqlite"));
  const adapters = buildAdapters(config, options?.adapters);
  const backend = await createSandboxBackend(config, adapters, options?.modalHost);
  const manager = new SessionManager(db, backend, config);
  manager.recover();
  const server = createHttpServer(config, manager);
  return {
    config,
    manager,
    server,
    async close() {
      const closed = new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      server.closeAllConnections?.();
      await closed;
      await manager.shutdown();
      db.close();
    },
  };
}

export function logReady(config: KennelConfig): void {
  const warning = claudeAuthWarning(process.env);
  if (warning) console.warn(`[kennel] ${warning}`);
  if (config.backend === "modal") {
    console.log(`[kennel] agent auth: from Modal Secret ${config.modalSecret} (not read by the control plane)`);
  } else {
    console.log(`[kennel] claude auth: ${describeClaudeAuth(process.env)}`);
  }
  console.log(`[kennel] listening on http://${config.host}:${config.port}`);
  console.log(`[kennel] data dir: ${config.dataDir}`);
  console.log(`[kennel] max concurrent sessions: ${config.maxConcurrent}`);
  console.log(`[kennel] sandbox backend: ${config.backend}`);
  console.log(
    `[kennel] triage: ${config.triageMode}${config.xaiApiKey ? ` model=${config.triageModel}` : " (no XAI_API_KEY)"}`,
  );
  // Never write the bearer token to stdout: under systemd it lands in the journal.
  console.log("[kennel] Grok Bot connector (replace <KENNEL_TOKEN> with the token):");
  console.log(connectorLine({ ...config, token: "<KENNEL_TOKEN>" }));
}
