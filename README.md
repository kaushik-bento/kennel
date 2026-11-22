# kennel

Kennel runs Claude Code and Codex as remote coding sessions. An orchestrator (Grok Bot, or anything else that speaks HTTP or MCP) creates a session, sends prompts, and reattaches to a stream of events. Humans can use the same API.

The control plane is a small Node 22 service: SQLite, a FIFO prompt queue, server-sent events, and an MCP endpoint. It does not use tmux. Each session runs in a pluggable sandbox:

- **`local`** — a git worktree and the agent process on the kennel host. This is the default so `npm test` and a laptop quickstart work without Modal.
- **`modal`** — one [Modal Sandbox](https://modal.com/docs/guide/sandbox) per session. This is the production backend. The worktree and the agent home directories live on a Modal Volume, so the sandbox can be torn down when the session is idle and recreated on the next prompt without losing Claude or Codex resume state.

## Quickstart (local)

```bash
npm ci
npm run build
export KENNEL_TOKEN="$(openssl rand -hex 24)"
export KENNEL_BACKEND=local
node --disable-warning=ExperimentalWarning packages/server/dist/index.js
```

The process listens on `127.0.0.1:8787` and prints a connector line you can paste into an MCP client. Point `repo` at a local checkout or a git URL the machine can clone.

```bash
curl -sS -H "Authorization: Bearer $KENNEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"repo":"/path/to/repo","baseBranch":"main","agent":"echo"}' \
  http://127.0.0.1:8787/sessions
```

`echo` is a fake agent that streams the prompt back. Use it to try the API. `claude` and `codex` need the corresponding CLIs and credentials on the host when the backend is `local`.

## Production (Modal)

1. Build the agent image once. It contains git, `gh`, Node 22, Claude Code, Codex, and `kennel-runner`:

   ```bash
   export MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=...
   npx tsx deploy/modal/build-image.ts
   ```

   The definition is `deploy/modal/Dockerfile`. The script publishes it as `kennel-agent`.

2. Create a Modal Secret named `kennel-agent` (override with `KENNEL_MODAL_SECRET`) with the agent credentials. Kennel only passes the **name** to Modal. It never reads or logs the values.

   - `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` (if both are set inside the sandbox, Claude Code uses the API key)
   - `OPENAI_API_KEY`, or Codex's `~/.codex` auth if you bake it into the volume another way
   - `GITHUB_TOKEN` so `gh pr create` can open a pull request

3. Run the control plane with `KENNEL_BACKEND=modal`, plus `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` for the Modal SDK. Optional: `KENNEL_MODAL_APP`, `KENNEL_MODAL_IMAGE`, `KENNEL_MODAL_ENVIRONMENT`, `KENNEL_MODAL_SANDBOX_TIMEOUT_MS` (default 4 hours; Modal's own default of 5 minutes is too short for a coding turn).

`deploy/gcp/startup.sh` is an Ubuntu 24.04 boot script for that control plane. It installs Node 22 and git, clones kennel, reads `kennel-token`, `modal-token-id`, and `modal-token-secret` from GCP Secret Manager, and runs kennel under systemd. It does not install Claude Code or Codex on the VM.

### Why the runner uses sandbox stdio

Each sandbox execs `kennel-runner`, a small process that imports the same Claude and Codex adapters the local backend uses. The control plane talks to it with newline-framed JSON on the exec stdin/stdout stream (`Sandbox.exec` in the Modal JS SDK, `modal` npm package).

A Modal tunnel would expose an HTTP port, a public URL, and a second credential. The stdio stream is already authenticated as the Modal client, carries both directions, and closes when the sandbox is gone. Stray logs from the agents stay on the runner's stderr; stdout is reserved for the protocol (lines start with `KENNEL\t`).

### What persists, and when the sandbox stops

`POST /sessions` creates a Volume named `kennel-<id>`, mounts it at `/var/kennel`, clones the repo, and adds the worktree. `HOME` inside the sandbox is `/var/kennel/home`, so `~/.claude` and `~/.codex` are on the volume. The sandbox is then terminated. The session is idle.

The next prompt creates a new sandbox on the same volume and resumes the native Claude session id or Codex thread id. When a turn finishes and the queue is empty, kennel releases the sandbox again. `KENNEL_SANDBOX_IDLE_MS` (default `0`) is how long to wait before that release. Modal's `timeoutMs` is only a backstop for a leaked sandbox.

Filesystem snapshots are a poor fit for this state: they exclude mounted volumes, and they expire (30 days by default). The Volume is the durable copy.

### Why the control plane is not a Modal web endpoint

The Modal JS SDK is a client for sandboxes, volumes, images, and secrets. It does not deploy a long-lived Node server. A Python `@modal.web_server` wrapper could start this process, but it is a bad home for it:

- Web endpoints autoscale. SQLite needs one writer. A Volume-backed database file plus a second container corrupts it.
- Clients hold SSE connections and long-polls. Modal's HTTP proxy is built for request/response, not an always-on session broker.
- The control plane is a few hundred megabytes of RAM and should restart in place. A VM (or the Docker image in this repo) matches that. The sandboxes are the part that should scale to zero.

## API

Every route requires `Authorization: Bearer $KENNEL_TOKEN`. The comparison is a SHA-256 of both strings, then `timingSafeEqual`. The default bind is `127.0.0.1`. Set `KENNEL_HOST` to listen elsewhere.

| Method | Path | Body |
| --- | --- | --- |
| `POST` | `/sessions` | `{repo, baseBranch, agent: "claude"\|"codex"\|"echo", permissions?, model?}` |
| `GET` | `/sessions` | |
| `GET` | `/sessions/:id` | state `idle\|running\|queued\|stopped\|error`, queue depth, branch, worktree path, native id, backend, sandbox id |
| `POST` | `/sessions/:id/prompts` | `{text, mode: "queue"\|"steer"}` |
| `GET` | `/sessions/:id/events` | SSE. `?after=` or `Last-Event-ID` replays. `Accept: application/json` plus `?waitMs=` long-polls |
| `POST` | `/sessions/:id/interrupt` | stop the current turn, keep the queue |
| `POST` | `/sessions/:id/stop` | interrupt and clear the queue |
| `POST` | `/sessions/:id/resume` | start the worker again on the same native session id |
| `POST` | `/sessions/:id/finish` | `{commitMessage, openPr?: true}` commit, push, `gh pr create` when `gh` is available |
| `DELETE` | `/sessions/:id` | close. `?cleanup=false` keeps the worktree or Modal volume |
| `POST`/`GET`/`DELETE` | `/mcp` | streamable HTTP MCP, same bearer token |
| `GET` | `/health` | `{ok: true}` |

`queue` appends to a FIFO. An idle session starts the turn when a concurrency slot is free (`KENNEL_MAX_CONCURRENT`, default 4); otherwise the session state becomes `queued`. `steer` injects into the in-flight turn: Codex `turn/steer`, or a Claude streaming user message with `priority: "now"` and `origin.kind: "human"`. If nothing is running, `steer` starts a turn.

Events are monotonic per database and filtered per session: `message_delta`, `tool_call`, `tool_result`, `turn_completed` (status and token usage), `error`, `status`. Each event also keeps the raw agent payload. A server restart marks sessions that were `running` as `error` and puts the in-flight prompt back on the queue. `POST /resume` continues them. Sessions that were only `queued` are eligible to start on boot.

### Permissions

```json
{
  "permissionMode": "acceptEdits",
  "allowedTools": ["Read", "Edit"],
  "disallowedTools": ["Bash"],
  "sandbox": "workspace-write",
  "approvalPolicy": "never",
  "networkAccess": true
}
```

Claude uses `permissionMode`, `allowedTools`, and `disallowedTools`. `bypassPermissions` also sets `allowDangerouslySkipPermissions`. Codex defaults to sandbox `workspace-write` and approval `never`. `sandbox` is `read-only`, `workspace-write`, or `danger-full-access`. If Codex still emits an approval request, kennel answers `{decision: "accept"}` when the policy is `never` and `{decision: "decline"}` otherwise, so a turn cannot sit waiting for a person.

### Claude auth

The Claude Agent SDK inherits the process environment. `CLAUDE_CODE_OAUTH_TOKEN` is the subscription token. `ANTHROPIC_API_KEY` is the API key. `CLAUDE_CODE_USE_VERTEX=1` selects Vertex. On startup, if both the OAuth token and the API key are set, kennel warns that the API key wins.

## MCP and Grok Bot

The same tools are on `POST /mcp` and in the `kennel-mcp` package, which is a stdio MCP server aimed at `npx`:

```bash
export KENNEL_URL=http://127.0.0.1:8787
export KENNEL_TOKEN=...
npx kennel-mcp
```

Tools: `create_session`, `list_sessions`, `get_session`, `send_prompt`, `get_events` (pass `after` and `waitMs` to long-poll), `interrupt`, `stop`, `resume`, `finish_session`, `close_session`.

In Grok Bot, add a custom connector either as a remote MCP server (`http://<host>:8787/mcp` plus `Authorization: Bearer $KENNEL_TOKEN`; the startup log prints the connector shape with the token redacted) or as the stdio command `npx kennel-mcp` with `KENNEL_URL` and `KENNEL_TOKEN`.

## Security

`KENNEL_TOKEN` is the root password for this service. Anyone who has it can create sessions and run agents.

`permissionMode: "bypassPermissions"`, Codex `approvalPolicy: "never"`, and `sandbox: "danger-full-access"` let the agent run commands and write files as the sandbox user. On the local backend that user is the kennel host user, so the blast radius is the host. On Modal the blast radius is that sandbox plus whatever the Modal Secret can reach (GitHub, the model providers, and the repo). Do not put production cloud credentials, database passwords, or broad cloud IAM keys on the host or in the agent secret. Prefer a GitHub token that can push one fork, and a model credential that can only run the agent.

Bind the control plane to localhost and put TLS and a network policy in front if anything other than the orchestrator can route to it. The Modal tokens on the control plane can create sandboxes; treat them like the kennel token.

## Develop

```bash
npm test
npm run typecheck
```

Node 22. Tests cover the queue and boot recovery, SSE replay (`after` and `Last-Event-ID`), the Claude and Codex adapters against fakes, and the Modal backend against an in-process runner that speaks the real protocol. They do not call Modal, Claude, or Codex.

SQLite comes from `node:sqlite`. The start script disables the experimental warning.

## Layout

- `packages/core` — types, the prompt state machine, bearer check
- `packages/server` — HTTP, SSE, SQLite, sandboxes, adapters, `kennel-runner`
- `packages/mcp` — `kennel-mcp` stdio proxy
- `deploy/gcp/startup.sh` — control-plane VM
- `deploy/modal` — agent image
