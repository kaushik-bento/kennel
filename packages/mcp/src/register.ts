import type { KennelApi } from "@kennel/core";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function fail(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

/**
 * Register the kennel tools on an MCP server. Descriptions are written for an
 * LLM orchestrator that dispatches coding tasks and then follows events.
 */
export function registerKennelTools(server: McpServer, api: KennelApi): void {
  server.registerTool(
    "create_session",
    {
      title: "Create session",
      description:
        "Create a kennel coding session. Kennel clones repo (or reuses a local checkout), fetches it, and adds a git worktree on a new branch named kennel/<id>. Nothing runs until you send_prompt. agent is claude, codex, or echo. echo is a local fake that replays the prompt; use it only for demos and tests. permissions.permissionMode and allowedTools/disallowedTools configure Claude. permissions.sandbox (default workspace-write) and approvalPolicy (default never) configure Codex. Returns the session id, branch, worktree path, and state.",
      inputSchema: z.object({
        repo: z.string().describe("Git URL or absolute path of a local checkout."),
        baseBranch: z.string().describe("Branch to start the worktree from, such as main."),
        agent: z.enum(["claude", "codex", "echo"]).describe("Which coding agent runs in the worktree."),
        model: z.string().optional().describe("Optional model id passed through to the agent."),
        permissions: z
          .object({
            permissionMode: z
              .enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"])
              .optional()
              .describe("Claude permission mode. bypassPermissions skips prompts and can run anything the OS user can."),
            allowedTools: z.array(z.string()).optional().describe("Claude tools to auto-approve. This does not limit the tool set."),
            disallowedTools: z.array(z.string()).optional().describe("Claude tools to deny, including in bypass mode for scoped rules."),
            sandbox: z
              .enum(["read-only", "workspace-write", "danger-full-access"])
              .optional()
              .describe("Codex sandbox. Default workspace-write. danger-full-access disables the sandbox."),
            approvalPolicy: z
              .enum(["untrusted", "on-request", "never"])
              .optional()
              .describe("Codex approval policy. Default never."),
            networkAccess: z.boolean().optional().describe("Codex sandbox network access. Default true for workspace-write."),
          })
          .optional(),
      }),
    },
    async (args) =>
      run(() =>
        api.createSession({
          repo: args.repo,
          baseBranch: args.baseBranch,
          agent: args.agent,
          ...(args.model ? { model: args.model } : {}),
          ...(args.permissions ? { permissions: args.permissions } : {}),
        }),
      ),
  );

  server.registerTool(
    "list_sessions",
    {
      title: "List sessions",
      description:
        "List kennel sessions that have not been closed. Each entry includes state (idle, running, queued, stopped, or error), queue depth, branch, worktree path, and the native Claude session id or Codex thread id when one exists.",
      inputSchema: z.object({}),
    },
    async () => run(() => api.listSessions()),
  );

  server.registerTool(
    "get_session",
    {
      title: "Get session",
      description:
        "Fetch one session by id, including state, queue depth, branch, worktree path, native session id, model, permissions, and the last error.",
      inputSchema: z.object({
        sessionId: z.string().describe("Kennel session id returned by create_session."),
      }),
    },
    async ({ sessionId }) => run(() => api.getSession(sessionId)),
  );

  server.registerTool(
    "send_prompt",
    {
      title: "Send prompt",
      description:
        "Send a user prompt to a session. mode=queue appends to the FIFO. If the session is idle and a concurrency slot is free, the turn starts immediately; otherwise the prompt waits and the session state becomes queued. mode=steer injects the text into the in-flight turn (Codex turn/steer, or a Claude priority-now user message) instead of waiting. If nothing is running, steer starts a turn the same way queue does. Stopped and error sessions reject prompts until resume.",
      inputSchema: z.object({
        sessionId: z.string(),
        text: z.string().describe("The instruction to give the coding agent."),
        mode: z.enum(["queue", "steer"]).describe("queue waits its turn; steer redirects the active turn."),
      }),
    },
    async ({ sessionId, text, mode }) => run(() => api.sendPrompt(sessionId, { text, mode })),
  );

  server.registerTool(
    "get_events",
    {
      title: "Get events",
      description:
        "Read the normalized event log for a session after a cursor. Pass the previous response's cursor, or 0 to start from the beginning. Events are message_delta, tool_call, tool_result, turn_completed (includes status and token usage), error, status, and attention. The raw agent payload is omitted unless includeRaw is true. types filters to those event types, and the returned cursor is the last event actually returned so a filtered view does not reread the same page. limit defaults to 200 and cannot exceed 500. Set waitMs to long-poll until a matching event arrives or the wait expires (maximum 60000).",
      inputSchema: z.object({
        sessionId: z.string(),
        after: z.number().int().nonnegative().optional().describe("Return events with id greater than this cursor."),
        waitMs: z
          .number()
          .int()
          .nonnegative()
          .max(60_000)
          .optional()
          .describe("Long-poll up to this many milliseconds when no matching event is waiting."),
        includeRaw: z.boolean().optional().describe("Include the raw agent payload. Defaults to false."),
        types: z
          .array(
            z.enum([
              "message_delta",
              "tool_call",
              "tool_result",
              "turn_completed",
              "error",
              "status",
              "attention",
            ]),
          )
          .optional()
          .describe("Return only these event types."),
        limit: z.number().int().positive().max(500).optional().describe("Maximum events to return. Defaults to 200."),
      }),
    },
    async ({ sessionId, after, waitMs, includeRaw, types, limit }) =>
      run(() =>
        api.getEvents(sessionId, {
          ...(after !== undefined ? { after } : {}),
          ...(waitMs !== undefined ? { waitMs } : {}),
          ...(includeRaw !== undefined ? { includeRaw } : {}),
          ...(types !== undefined ? { types } : {}),
          ...(limit !== undefined ? { limit } : {}),
        }),
      ),
  );

  server.registerTool(
    "interrupt",
    {
      title: "Interrupt turn",
      description:
        "Interrupt the in-flight turn and keep every queued prompt. The current turn ends with status interrupted, then the next queued prompt starts when a concurrency slot is free. No-op when the session is idle.",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => run(() => api.interrupt(sessionId)),
  );

  server.registerTool(
    "stop",
    {
      title: "Stop session",
      description:
        "Interrupt the in-flight turn, cancel every queued prompt, and mark the session stopped. Further send_prompt calls fail until resume.",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => run(() => api.stop(sessionId)),
  );

  server.registerTool(
    "resume",
    {
      title: "Resume session",
      description:
        "Restart the agent worker on the same native Claude session id or Codex thread id. Use this after a server restart or a process crash left the session in error, or to reopen a stopped session. Queued prompts start when a concurrency slot is free. A session that is already running is left alone.",
      inputSchema: z.object({ sessionId: z.string() }),
    },
    async ({ sessionId }) => run(() => api.resume(sessionId)),
  );

  server.registerTool(
    "finish_session",
    {
      title: "Finish session",
      description:
        "Commit the worktree, push the kennel/<id> branch, and open a GitHub pull request with the gh CLI when openPr is true (the default). The session must not be running or queued. If gh is missing, the commit and push still succeed and prError explains why there is no URL. Returns committed, commit sha, branch, pushed, prUrl, and prError.",
      inputSchema: z.object({
        sessionId: z.string(),
        commitMessage: z.string().describe("Git commit message and, when a PR is opened, the PR title."),
        openPr: z.boolean().optional().describe("Open a pull request. Defaults to true."),
      }),
    },
    async ({ sessionId, commitMessage, openPr }) =>
      run(() =>
        api.finishSession(sessionId, {
          commitMessage,
          ...(openPr !== undefined ? { openPr } : {}),
        }),
      ),
  );

  server.registerTool(
    "close_session",
    {
      title: "Close session",
      description:
        "Stop the session if it is running, cancel queued prompts, and remove it from the active list. cleanup defaults to true and deletes the git worktree Kennel created. The shared repo cache is kept. Pass cleanup=false to leave the worktree on disk.",
      inputSchema: z.object({
        sessionId: z.string(),
        cleanup: z.boolean().optional().describe("Delete the worktree. Defaults to true."),
      }),
    },
    async ({ sessionId, cleanup }) =>
      run(() => api.closeSession(sessionId, cleanup === undefined ? {} : { cleanup })),
  );

  server.registerTool(
    "list_flags",
    {
      title: "List attention flags",
      description:
        "List attention flags raised when triage decided a person should look. unacknowledgedOnly defaults to true. minSeverity is info, warn, or urgent. Filter to one session with sessionId.",
      inputSchema: z.object({
        sessionId: z.string().optional(),
        unacknowledgedOnly: z.boolean().optional().describe("Only flags that have not been acknowledged. Defaults to true."),
        minSeverity: z.enum(["info", "warn", "urgent"]).optional(),
      }),
    },
    async ({ sessionId, unacknowledgedOnly, minSeverity }) =>
      run(() =>
        api.listFlags({
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(unacknowledgedOnly !== undefined ? { unacknowledgedOnly } : {}),
          ...(minSeverity !== undefined ? { minSeverity } : {}),
        }),
      ),
  );

  server.registerTool(
    "ack_flag",
    {
      title: "Acknowledge flag",
      description: "Mark an attention flag as acknowledged so it drops out of the default flag list and the digest.",
      inputSchema: z.object({ id: z.string().describe("Flag id.") }),
    },
    async ({ id }) => run(() => api.ackFlag(id)),
  );

  server.registerTool(
    "get_summaries",
    {
      title: "Get batch summaries",
      description:
        "Read triage batch summaries for a session, newest first. Each summary covers the turns since the previous triage and records fromPromptId and toPromptId.",
      inputSchema: z.object({
        sessionId: z.string(),
        limit: z.number().int().positive().max(100).optional().describe("How many summaries to return. Defaults to 20."),
      }),
    },
    async ({ sessionId, limit }) =>
      run(() => api.getSummaries(sessionId, limit === undefined ? {} : { limit })),
  );

  server.registerTool(
    "digest",
    {
      title: "Session digest",
      description:
        "One row per live session: id, repo, agent, state, the rolling session summary, the count of open flags, and the highest open severity. Sorted urgent, warn, info, then none, and by open flag count within a severity.",
      inputSchema: z.object({}),
    },
    async () => run(() => api.digest()),
  );
}
