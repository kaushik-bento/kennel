import type { PromptMode, SessionState } from "./types.js";

export type PromptPlan =
  | { type: "reject"; message: string }
  | { type: "steer" }
  | { type: "enqueue"; state: "queued" | "running" }
  | { type: "start" };

/**
 * What to do with a prompt given the session and the global running-session count.
 * `runningSessions` includes this session when its state is already `running`.
 */
export function planPrompt(input: {
  state: SessionState;
  mode: PromptMode;
  turnActive: boolean;
  runningSessions: number;
  maxConcurrent: number;
}): PromptPlan {
  if (input.state === "stopped") {
    return { type: "reject", message: "session is stopped; POST /resume to reopen it" };
  }
  if (input.state === "error") {
    return { type: "reject", message: "session is in error; POST /resume to continue" };
  }
  if (input.mode === "steer" && input.turnActive) {
    return { type: "steer" };
  }
  if (input.turnActive) {
    return { type: "enqueue", state: "running" };
  }
  const holdsSlot = input.state === "running";
  const others = holdsSlot ? Math.max(0, input.runningSessions - 1) : input.runningSessions;
  if (others < input.maxConcurrent) {
    return { type: "start" };
  }
  return { type: "enqueue", state: "queued" };
}

export function planAfterTurn(input: {
  stopRequested: boolean;
  queuedCount: number;
}): { state: "stopped" | "idle" | "running"; startNext: boolean } {
  if (input.stopRequested) return { state: "stopped", startNext: false };
  if (input.queuedCount > 0) return { state: "running", startNext: true };
  return { state: "idle", startNext: false };
}

/**
 * A turn that was `running` when the process died did not finish.
 * Put that prompt back on the queue and require an explicit resume.
 * Sessions that were only waiting for a slot stay queued and may start on boot.
 */
export function planBootRecovery(state: SessionState): {
  state: SessionState;
  error: string | null;
  requeueRunningPrompt: boolean;
} {
  if (state === "running") {
    return {
      state: "error",
      error: "server restarted while a turn was running; POST /resume to continue",
      requeueRunningPrompt: true,
    };
  }
  return { state, error: null, requeueRunningPrompt: false };
}
