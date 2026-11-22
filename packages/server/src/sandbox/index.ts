import type { AgentAdapter } from "../adapters/types.js";
import type { KennelConfig } from "../config.js";
import { GitWorkspace } from "../git.js";
import { LocalSandboxBackend } from "./local.js";
import { connectModalHost } from "./modal-host.js";
import { ModalSandboxBackend } from "./modal.js";
import type { ModalHost, SandboxBackend } from "./types.js";

export type { AgentConnection, ModalHost, SandboxBackend } from "./types.js";

export async function createSandboxBackend(
  config: KennelConfig,
  adapters: Map<string, AgentAdapter>,
  modalHost?: ModalHost,
): Promise<SandboxBackend> {
  if (config.backend === "local") {
    return new LocalSandboxBackend(new GitWorkspace(config.dataDir), adapters);
  }
  const host = modalHost ?? (await connectModalHost(config));
  return new ModalSandboxBackend(host, config.modalSecret);
}
