import type { AgentKind } from "@kennel/core";
import type { AgentAdapter, AgentStartOptions, RunningAgent } from "../adapters/types.js";
import type { SessionRow } from "../db.js";
import { GitWorkspace } from "../git.js";
import type { AgentConnection, FinishRequest, SandboxBackend, SandboxProvision } from "./types.js";

class LocalConnection implements AgentConnection {
  readonly sandboxId = null;
  private agent: RunningAgent | null = null;

  constructor(
    private readonly adapters: Map<string, AgentAdapter>,
    private readonly session: SessionRow,
  ) {}

  async startAgent(options: AgentStartOptions & { kind: AgentKind }): Promise<RunningAgent> {
    const adapter = this.adapters.get(options.kind);
    if (!adapter) throw new Error(`unknown agent: ${options.kind}`);
    this.agent = await adapter.start({ ...options, cwd: this.session.worktreePath });
    return this.agent;
  }

  async release(): Promise<void> {
    if (this.agent) await this.agent.close().catch(() => undefined);
    this.agent = null;
  }
}

/** Agent processes and git worktrees on the kennel host. Used for dev and tests. */
export class LocalSandboxBackend implements SandboxBackend {
  readonly kind = "local" as const;

  constructor(
    private readonly git: GitWorkspace,
    private readonly adapters: Map<string, AgentAdapter>,
  ) {}

  async provision(input: {
    sessionId: string;
    repo: string;
    baseBranch: string;
    branch: string;
  }): Promise<SandboxProvision> {
    const prepared = await this.git.ensure(input);
    return {
      worktreePath: prepared.worktreePath,
      sourcePath: prepared.sourcePath,
      sandboxId: null,
      volumeName: null,
    };
  }

  acquire(session: SessionRow): Promise<AgentConnection> {
    return Promise.resolve(new LocalConnection(this.adapters, session));
  }

  finish(session: SessionRow, input: FinishRequest) {
    return this.git.finish({
      worktreePath: session.worktreePath,
      branch: session.branch,
      baseBranch: session.baseBranch,
      commitMessage: input.commitMessage,
      openPr: input.openPr,
      repo: session.repo,
    });
  }

  async destroy(session: SessionRow, cleanup: boolean): Promise<void> {
    if (!cleanup) return;
    await this.git.remove(session.sourcePath, session.worktreePath, session.branch);
  }
}
