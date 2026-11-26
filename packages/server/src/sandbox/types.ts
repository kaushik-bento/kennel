import type { AgentKind, FinishResult } from "@kennel/core";
import type { AgentStartOptions, RunningAgent } from "../adapters/types.js";
import type { SessionRow } from "../db.js";

export interface SandboxProvision {
  worktreePath: string;
  sourcePath: string;
  sandboxId: string | null;
  volumeName: string | null;
}

export interface FinishRequest {
  commitMessage: string;
  openPr: boolean;
  events?: Array<{ type: string; data: Record<string, unknown> }>;
}

export interface AgentConnection {
  sandboxId: string | null;
  startAgent(options: AgentStartOptions & { kind: AgentKind }): Promise<RunningAgent>;
  release(): Promise<void>;
  /** Processes the agent started that are still running in the sandbox. Absent on backends that cannot tell. */
  activity?(): Promise<{ busy: number; processes: string[] }>;
}

/**
 * Where a session's git worktree and agent process live.
 * `local` is the kennel host. `modal` is one Modal Sandbox per session.
 */
export interface SandboxBackend {
  readonly kind: "local" | "modal";
  provision(input: {
    sessionId: string;
    repo: string;
    baseBranch: string;
    branch: string;
  }): Promise<SandboxProvision>;
  acquire(session: SessionRow): Promise<AgentConnection>;
  finish(session: SessionRow, input: FinishRequest): Promise<Omit<FinishResult, "branch">>;
  destroy(session: SessionRow, cleanup: boolean): Promise<void>;
}

export interface RunnerStdio {
  sandboxId: string | null;
  write(frame: string): Promise<void>;
  lines(): AsyncIterable<string>;
  close(): Promise<void>;
}

export interface ModalOpenSpec {
  sessionId: string;
  volumeName: string;
  secretName: string;
  /** Extra Modal Secret names (eval keys). */
  extraSecretNames?: string[];
  imageName?: string;
  cpu?: number;
  memoryMiB?: number;
}

/**
 * The slice of the Modal SDK kennel uses. Tests pass a fake.
 * The real implementation lives in `modal-host.ts` and is loaded only when
 * `KENNEL_BACKEND=modal`.
 */
export interface ModalHost {
  open(spec: ModalOpenSpec): Promise<RunnerStdio>;
  deleteVolume(volumeName: string): Promise<void>;
  /** False when that published image cannot be resolved. */
  imageExists?(name: string): Promise<boolean>;
}
