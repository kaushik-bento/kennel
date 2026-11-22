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
  /** Rolling summary of the whole session. Null until the first triage. */
  sessionSummary: string | null;
  /** Latest triage batch summary. Null until the first triage. */
  lastBatchSummary: string | null;
  /** Unacknowledged attention flags. */
  openFlags: number;
  createdAt: string;
  updatedAt: string;
}

export const KENNEL_EVENT_TYPES = [
  "message_delta",
  "tool_call",
  "tool_result",
  "turn_completed",
  "error",
  "status",
  "attention",
] as const;

export type KennelEventType = (typeof KENNEL_EVENT_TYPES)[number];

export const ATTENTION_SEVERITIES = ["info", "warn", "urgent"] as const;
export type AttentionSeverity = (typeof ATTENTION_SEVERITIES)[number];

export const ATTENTION_KINDS = [
  "agent_question",
  "blocked",
  "stuck_or_looping",
  "tests_failing",
  "risky_action",
  "claimed_done_unverified",
  "scope_drift",
  "error",
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export const TRIAGE_MODES = ["idle", "every_turn", "off"] as const;
export type TriageMode = (typeof TRIAGE_MODES)[number];

export interface AttentionReason {
  kind: AttentionKind;
  summary: string;
  evidence: string;
}

export interface FlagView {
  id: string;
  sessionId: string;
  promptId: string | null;
  severity: AttentionSeverity;
  reasons: AttentionReason[];
  suggestedAction: string;
  createdAt: string;
  acknowledgedAt: string | null;
}

export interface SummaryView {
  id: string;
  sessionId: string;
  fromPromptId: string | null;
  toPromptId: string | null;
  summary: string;
  createdAt: string;
}

export interface DigestEntry {
  id: string;
  repo: string;
  agent: AgentKind;
  state: SessionState;
  sessionSummary: string | null;
  openFlags: number;
  highestSeverity: AttentionSeverity | null;
}

export interface EventQuery {
  after?: number;
  waitMs?: number;
  /** Include the raw agent payload. Default false. */
  includeRaw?: boolean;
  types?: KennelEventType[];
  limit?: number;
}

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
  getEvents(id: string, opts: EventQuery): Promise<EventPage>;
  interrupt(id: string): Promise<SessionView>;
  stop(id: string): Promise<SessionView>;
  resume(id: string): Promise<SessionView>;
  finishSession(id: string, input: FinishInput): Promise<FinishResult>;
  closeSession(id: string, opts?: { cleanup?: boolean }): Promise<{ deleted: true; cleanup: boolean }>;
  listFlags(opts: { sessionId?: string; unacknowledgedOnly?: boolean; minSeverity?: AttentionSeverity }): Promise<FlagView[]>;
  ackFlag(id: string): Promise<FlagView>;
  getSummaries(sessionId: string, opts?: { limit?: number }): Promise<SummaryView[]>;
  digest(): Promise<DigestEntry[]>;
}
