export const AGENT_KINDS = ["claude", "codex", "echo"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const SESSION_STATES = ["idle", "running", "queued", "stopped", "error"] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const PROMPT_MODES = ["queue", "steer"] as const;
export type PromptMode = (typeof PROMPT_MODES)[number];

export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

/** Codex `approvalPolicy` values from the current app-server schema. */
export const APPROVAL_POLICIES = ["untrusted", "on-request", "never"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export interface Permissions {
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  /** Codex workspace-write / read-only network access. Defaults to true for workspace-write. */
  networkAccess?: boolean;
}

export type SandboxBackendKind = "local" | "modal";

export interface SessionView {
  id: string;
  agent: AgentKind;
  repo: string;
  baseBranch: string;
  branch: string;
  worktreePath: string;
  state: SessionState;
  queueDepth: number;
  nativeSessionId: string | null;
  model: string | null;
  permissions: Permissions;
  error: string | null;
  backend: SandboxBackendKind;
  /** Modal sandbox id while one is running. Null on the local backend and after an idle shutdown. */
  sandboxId: string | null;
  createdAt: string;
  updatedAt: string;
}

export type KennelEventType =
  | "message_delta"
  | "tool_call"
  | "tool_result"
  | "turn_completed"
  | "error"
  | "status";

export interface KennelEvent {
  id: number;
  sessionId: string;
  type: KennelEventType;
  createdAt: string;
  data: Record<string, unknown>;
  raw?: unknown;
}

export interface PromptResult {
  promptId: string;
  delivery: "started" | "queued" | "steered";
  state: SessionState;
  queueDepth: number;
}

export interface FinishResult {
  committed: boolean;
  commit: string | null;
  branch: string;
  pushed: boolean;
  prUrl: string | null;
  prError: string | null;
}

export interface EventPage {
  events: KennelEvent[];
  cursor: number;
}

export interface CreateSessionInput {
  repo: string;
  baseBranch: string;
  agent: AgentKind;
  permissions?: Permissions;
  model?: string;
}

export interface SendPromptInput {
  text: string;
  mode: PromptMode;
}

export interface FinishInput {
  commitMessage: string;
  openPr?: boolean;
}

/**
 * Operations exposed over HTTP and both MCP surfaces.
 * Tool handlers and the stdio proxy speak this interface only.
 */
export interface KennelApi {
  createSession(input: CreateSessionInput): Promise<SessionView>;
  listSessions(): Promise<SessionView[]>;
  getSession(id: string): Promise<SessionView>;
  sendPrompt(id: string, input: SendPromptInput): Promise<PromptResult>;
  getEvents(id: string, opts: { after?: number; waitMs?: number }): Promise<EventPage>;
  interrupt(id: string): Promise<SessionView>;
  stop(id: string): Promise<SessionView>;
  resume(id: string): Promise<SessionView>;
  finishSession(id: string, input: FinishInput): Promise<FinishResult>;
  closeSession(id: string, opts?: { cleanup?: boolean }): Promise<{ deleted: true; cleanup: boolean }>;
}
