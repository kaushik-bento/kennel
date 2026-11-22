import type { AgentKind, Permissions } from "@kennel/core";

export type AgentEventType = "message_delta" | "tool_call" | "tool_result" | "turn_completed" | "error";

export interface AgentEvent {
  type: AgentEventType;
  data: Record<string, unknown>;
  raw?: unknown;
}

export interface AgentStartOptions {
  cwd: string;
  nativeId: string | null;
  model?: string;
  permissions: Permissions;
  onEvent: (event: AgentEvent) => void;
  onNativeId: (id: string) => void;
  /** Profile testing notes. Claude appends them to the system prompt. */
  testingAddendum?: string;
  extraEnv?: Record<string, string>;
  stripEnv?: string[];
}

export interface RunningAgent {
  nativeId: string | null;
  /** Accept a user message. Resolves once the agent has accepted it, not when the turn finishes. */
  deliver(text: string): Promise<void>;
  /** Inject text into the in-flight turn. */
  steer(text: string): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentAdapter {
  readonly kind: AgentKind;
  start(options: AgentStartOptions): Promise<RunningAgent>;
}
