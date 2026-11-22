import type { AgentAdapter } from "../adapters/types.js";
import type { KennelConfig } from "../config.js";
import { EnvCatalog } from "../envprofile/catalog.js";
import { publishEnvironmentImage } from "../envprofile/build.js";
import { hashLockfiles, imageName } from "../envprofile/hash.js";
import type { EnvProfile } from "../envprofile/types.js";
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
  const catalog = EnvCatalog.load(config.envDir, config.dataDir);
  if (config.backend === "local") {
    return new LocalSandboxBackend(new GitWorkspace(config.dataDir), adapters, catalog);
  }
  const host = modalHost ?? (await connectModalHost(config));
  const rebuild = config.envAutobuild
    ? async (profile: EnvProfile, _hash: string, _desired: string) => {
        const repo = profile.repos[0];
        if (!repo) return;
        const inspected = await catalog.inspect(repo, profile);
        const tag = imageName(profile, hashLockfiles(inspected.lockfiles));
        await publishEnvironmentImage({
          profile,
          repoUrl: repo,
          gitSha: inspected.sha,
          imageName: tag,
          appName: config.modalApp,
          secretName: config.modalSecret,
          baseImage: config.modalImage,
          ...(config.modalEnvironment ? { environment: config.modalEnvironment } : {}),
        });
      }
    : undefined;
  return new ModalSandboxBackend(host, config.modalSecret, catalog, {
    fallbackImage: config.modalImage,
    ...(rebuild ? { rebuild } : {}),
  });
}
