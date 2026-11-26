import type { AgentKind } from "@kennel/core";
import type { AgentAdapter, AgentStartOptions, RunningAgent } from "../adapters/types.js";
import type { SessionEnvironment } from "../envprofile/catalog.js";
import { EnvCatalog } from "../envprofile/catalog.js";
import { checkList } from "../envprofile/load.js";
import { installTestingDoc } from "../envprofile/workspace-files.js";
import type { SessionRow } from "../db.js";
import { GitWorkspace } from "../git.js";
import type { AgentConnection, FinishRequest, SandboxBackend, SandboxProvision } from "./types.js";

class LocalConnection implements AgentConnection {
  readonly sandboxId = null;
  private agent: RunningAgent | null = null;

  constructor(
    private readonly adapters: Map<string, AgentAdapter>,
    private readonly session: SessionRow,
    private readonly environment: SessionEnvironment | null,
  ) {}

  async startAgent(options: AgentStartOptions & { kind: AgentKind }): Promise<RunningAgent> {
    const adapter = this.adapters.get(options.kind);
    if (!adapter) throw new Error(`unknown agent: ${options.kind}`);
    this.agent = await adapter.start({
      ...options,
      cwd: this.session.worktreePath,
      ...(this.environment
        ? {
            testingAddendum: this.environment.testingDoc,
            extraEnv: this.environment.env,
            stripEnv: this.environment.stripEnv,
          }
        : {}),
    });
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
    private readonly catalog: EnvCatalog,
  ) {}

  private readonly environments = new Map<string, SessionEnvironment>();

  async provision(input: {
    sessionId: string;
    repo: string;
    baseBranch: string;
    branch: string;
  }): Promise<SandboxProvision> {
    const prepared = await this.git.ensure(input);
    const plan = await this.catalog.prepare(input.repo, {
      fallbackImage: "local",
      imageExists: () => false,
      skipImage: true,
    });
    if (plan.environment) {
      installTestingDoc(prepared.worktreePath, plan.environment.testingDoc);
      this.environments.set(input.sessionId, plan.environment);
    }
    return {
      worktreePath: prepared.worktreePath,
      sourcePath: prepared.sourcePath,
      sandboxId: null,
      volumeName: null,
    };
  }

  acquire(session: SessionRow): Promise<AgentConnection> {
    return Promise.resolve(new LocalConnection(this.adapters, session, this.environments.get(session.id) ?? null));
  }

  finish(session: SessionRow, input: FinishRequest) {
    const profile = this.catalog.match(session.repo);
    return this.git.finish({
      worktreePath: session.worktreePath,
      branch: session.branch,
      baseBranch: session.baseBranch,
      commitMessage: input.commitMessage,
      openPr: input.openPr,
      repo: session.repo,
      ...(profile ? { checks: { tiers: checkList(profile), events: input.events ?? [] } } : {}),
    });
  }

  async destroy(session: SessionRow, cleanup: boolean): Promise<void> {
    if (!cleanup) return;
    await this.git.remove(session.sourcePath, session.worktreePath, session.branch);
  }
}
