import { checkList } from "../envprofile/load.js";
import type { EnvCatalog } from "../envprofile/catalog.js";
import type { EnvProfile } from "../envprofile/types.js";
import type { SessionRow } from "../db.js";
import { RunnerConnection } from "./runner-client.js";
import type { FinishRequest, ModalHost, ModalOpenSpec, SandboxBackend, SandboxProvision } from "./types.js";

const MOUNT = "/var/kennel";

/**
 * One Modal Sandbox per session. The repo, worktree, and the agent home
 * directories (~/.claude, ~/.codex via HOME=/var/kennel/home) live on a Volume,
 * so tearing the sandbox down does not drop resume state.
 *
 * The control plane drives a `kennel-runner` process over the sandbox exec
 * stdio stream. A tunnel would publish a network port and a second auth
 * scheme; stdio stays on the Modal client connection and dies with it.
 */
export class ModalSandboxBackend implements SandboxBackend {
  readonly kind = "modal" as const;

  constructor(
    private readonly host: ModalHost,
    private readonly secretName: string,
    private readonly catalog: EnvCatalog,
    private readonly images: {
      fallbackImage: string;
      rebuild?: (profile: EnvProfile, hash: string, desired: string) => Promise<void>;
    },
  ) {}

  async provision(input: {
    sessionId: string;
    repo: string;
    baseBranch: string;
    branch: string;
  }): Promise<SandboxProvision> {
    const volumeName = volumeNameFor(input.sessionId);
    const connection = await this.open(input.sessionId, volumeName, input.repo);
    let provisioned = false;
    try {
      const boot = await connection.rpc("bootstrap", {
        root: MOUNT,
        repo: input.repo,
        baseBranch: input.baseBranch,
        branch: input.branch,
        sessionId: input.sessionId,
        ...(connection.environment ? { environment: connection.environment } : {}),
      });
      provisioned = true;
      return {
        worktreePath: String(boot.worktreePath),
        sourcePath: String(boot.sourcePath),
        sandboxId: null,
        volumeName,
      };
    } finally {
      await connection.release();
      if (!provisioned) {
        await this.host.deleteVolume(volumeName).catch(() => undefined);
      }
    }
  }

  async acquire(session: SessionRow): Promise<RunnerConnection> {
    if (!session.volumeName) throw new Error("modal session is missing its volume");
    const connection = await this.open(session.id, session.volumeName, session.repo);
    try {
      await connection.rpc("bootstrap", {
        root: MOUNT,
        repo: session.repo,
        baseBranch: session.baseBranch,
        branch: session.branch,
        sessionId: session.id,
        ...(connection.environment ? { environment: connection.environment } : {}),
      });
    } catch (err) {
      await connection.release().catch(() => undefined);
      throw err;
    }
    return connection;
  }

  async finish(session: SessionRow, input: FinishRequest) {
    const connection = await this.acquire(session);
    try {
      const profile = this.catalog.match(session.repo);
      const result = await connection.rpc("finish", {
        branch: session.branch,
        baseBranch: session.baseBranch,
        commitMessage: input.commitMessage,
        openPr: input.openPr,
        repo: session.repo,
        ...(profile
          ? { checks: { tiers: checkList(profile), events: input.events ?? [] } }
          : {}),
      });
      return {
        committed: Boolean(result.committed),
        commit: typeof result.commit === "string" ? result.commit : null,
        pushed: Boolean(result.pushed),
        prUrl: typeof result.prUrl === "string" ? result.prUrl : null,
        prError: typeof result.prError === "string" ? result.prError : null,
      };
    } finally {
      await connection.release();
    }
  }

  async destroy(session: SessionRow, cleanup: boolean): Promise<void> {
    if (session.volumeName && cleanup) {
      await this.host.deleteVolume(session.volumeName);
    }
  }

  private async open(sessionId: string, volumeName: string, repo: string): Promise<RunnerConnection & { environment?: unknown }> {
    const prepared = await this.catalog.prepare(repo, {
      fallbackImage: this.images.fallbackImage,
      imageExists: (name) => (this.host.imageExists ? this.host.imageExists(name) : false),
      ...(this.images.rebuild ? { rebuild: this.images.rebuild } : {}),
    });
    const spec: ModalOpenSpec = {
      sessionId,
      volumeName,
      secretName: this.secretName,
      ...(prepared.decision.profile ? { imageName: prepared.decision.image } : {}),
      ...(prepared.resources.cpu ? { cpu: prepared.resources.cpu } : {}),
      ...(prepared.resources.memoryMiB ? { memoryMiB: prepared.resources.memoryMiB } : {}),
    };
    const io = await this.host.open(spec);
    const connection = new RunnerConnection(io) as RunnerConnection & { environment?: unknown };
    if (prepared.environment) connection.environment = prepared.environment;
    return connection;
  }
}

export function volumeNameFor(sessionId: string): string {
  return `kennel-${sessionId}`;
}
