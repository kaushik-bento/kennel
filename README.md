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

3. Run the control plane with `KENNEL_BACKEND=modal`, plus `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` for the Modal SDK. Optional: `KENNEL_MODAL_APP`, `KENNEL_MODAL_IMAGE`, `KENNEL_MODAL_ENVIRONMENT`, `KENNEL_MODAL_SANDBOX_TIMEOUT_MS` (default 8 hours; Modal's own default of 5 minutes is too short for a coding turn), and `KENNEL_MODAL_EXTRA_SECRETS`, a comma list of extra Modal Secrets (for example eval keys such as `openai-eval-key,fish-audio-api-key`) attached to every sandbox by name. A missing one is logged and skipped.

`deploy/gcp/startup.sh` is an Ubuntu 24.04 boot script for that control plane. It installs Node 22 and git, clones kennel, reads `kennel-token`, `modal-token-id`, and `modal-token-secret` from GCP Secret Manager, and runs kennel under systemd. It does not install Claude Code or Codex on the VM.

### Why the runner uses sandbox stdio

Each sandbox execs `kennel-runner`, a small process that imports the same Claude and Codex adapters the local backend uses. The control plane talks to it with newline-framed JSON on the exec stdin/stdout stream (`Sandbox.exec` in the Modal JS SDK, `modal` npm package).

A Modal tunnel would expose an HTTP port, a public URL, and a second credential. The stdio stream is already authenticated as the Modal client, carries both directions, and closes when the sandbox is gone. Stray logs from the agents stay on the runner's stderr; stdout is reserved for the protocol (lines start with `KENNEL\t`).

### What persists, and when the sandbox stops

`POST /sessions` creates a Volume named `kennel-<id>`, mounts it at `/var/kennel`, clones the repo, and adds the worktree. `HOME` inside the sandbox is `/var/kennel/home`, so `~/.claude` and `~/.codex` are on the volume. The sandbox is then terminated. The session is idle.

When a turn finishes and the queue is empty, kennel keeps the sandbox and the agent process for `KENNEL_SANDBOX_IDLE_MS` (default 30 minutes). A prompt in that window goes to the same sandbox and the same agent process, so background shells and subagents keep running. When the window ends, kennel asks the runner for live processes the agent started (bun install, tsc, test runs, background shells). While there are any, the sandbox stays up, checked every minute, up to `KENNEL_SANDBOX_BUSY_MAX_MS` (default 3 hours) after the turn ended. Then the sandbox is released; the next prompt creates a new sandbox on the same volume and resumes the native Claude session id or Codex thread id. A turn the agent starts on its own while idle (for example after a background task finishes) shows the session as running and resets the window. Set `KENNEL_SANDBOX_IDLE_MS=0` to release right after each turn. Modal's `timeoutMs` is only a backstop for a leaked sandbox.

Session volumes are created as Modal VolumeFS v2. v1 volumes cap at 500,000 inodes, and one `bun install` of a large monorepo writes more than that (node_modules plus the bun cache), which fails as ENOSPC with the disk nearly empty. Package manager caches (`BUN_INSTALL_CACHE_DIR` at `/root/.bun/install/cache`, which env images pre-warm, and npm, yarn, pnpm, pip, turbo under `/tmp/kennel-cache`) stay on the sandbox's ephemeral root disk. Node gets `--max-old-space-size` at 60% of the sandbox memory so a full monorepo `tsc` does not stop at the default heap.

The base image has bun (pinned in `deploy/modal/Dockerfile`), Playwright Chromium with its system libraries and fonts (`PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`), and build tools. When an env profile image for the current lockfile is not published yet, kennel uses the newest image built for one of the last 8 lockfile revisions and tells the agent to reinstall dependencies, before it falls back to the base image.

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
| `GET` | `/sessions/:id` | state `idle\|running\|queued\|stopped\|error`, queue depth, branch, worktree path, native id, backend, sandbox id, `sessionSummary`, `lastBatchSummary`, `openFlags` |
| `POST` | `/sessions/:id/prompts` | `{text, mode: "queue"\|"steer"}` |
| `GET` | `/sessions/:id/events` | SSE. `?after=` or `Last-Event-ID` replays. `?types=tool_call,error` filters. `?limit=` defaults to 200 (max 500). `?raw=1` includes the agent payload. `Accept: application/json` plus `?waitMs=` long-polls |
| `GET` | `/sessions/:id/summaries` | triage batch summaries, newest first. `?limit=` |
| `GET` | `/flags` | attention flags. `?sessionId=`, `?unacknowledged=false`, `?minSeverity=warn` |
| `POST` | `/flags/:id/ack` | mark a flag acknowledged |
| `GET` | `/digest` | every live session with its summary and open flags |
| `POST` | `/sessions/:id/interrupt` | stop the current turn, keep the queue |
| `POST` | `/sessions/:id/stop` | interrupt and clear the queue |
| `POST` | `/sessions/:id/resume` | start the worker again on the same native session id |
| `POST` | `/sessions/:id/finish` | `{commitMessage, openPr?: true}` commit, push, `gh pr create` when `gh` is available |
| `DELETE` | `/sessions/:id` | close. `?cleanup=false` keeps the worktree or Modal volume |
| `POST`/`GET`/`DELETE` | `/mcp` | streamable HTTP MCP, same bearer token |
| `GET` | `/health` | `{ok: true}` |

`queue` appends to a FIFO. An idle session starts the turn when a concurrency slot is free (`KENNEL_MAX_CONCURRENT`, default 4); otherwise the session state becomes `queued`. `steer` injects into the in-flight turn: Codex `turn/steer`, or a Claude streaming user message with `priority: "now"` and `origin.kind: "human"`. If nothing is running, `steer` starts a turn.

Events are monotonic per database and filtered per session: `message_delta`, `tool_call`, `tool_result`, `turn_completed` (status and token usage), `error`, `status`, and `attention`. The raw agent payload is stored but omitted from SSE and JSON reads unless `?raw=1` (MCP: `includeRaw: true`). A `types` filter is applied in SQL, and the cursor in the response is the last event returned, so a filtered client does not reread the same page. A server restart marks sessions that were `running` as `error` and puts the in-flight prompt back on the queue. `POST /resume` continues them. Sessions that were only `queued` are eligible to start on boot.

### Attention triage

When `XAI_API_KEY` is set, kennel asks xAI (`KENNEL_TRIAGE_MODEL`, default `grok-4.3`) whether a person should look. `KENNEL_TRIAGE_MODE` is `idle` (the default), `every_turn`, or `off`.

`idle` makes one call when the prompt queue drains, covering every turn since the last successful triage. It also calls immediately when a turn ends `failed`, `interrupted`, or `error`, and when the final assistant message looks like it is waiting: it ends with a question, or it mentions waiting for input or approval, an auth or permission failure, or a rate limit. `every_turn` calls after each turn. `off`, or a missing API key, never calls.

One request returns both the triage and the summaries. `batchSummary` is two to four sentences about the turns in that batch and is stored with `fromPromptId` and `toPromptId`. `sessionSummary` is a rolling summary of at most 150 words, rewritten from the previous one in the same call. A flag is stored only when `needsAttention` is true, and an `attention` event is emitted. `KENNEL_ATTENTION_WEBHOOK` receives the same JSON. A failed call is retried once, logged as `triage_error`, and does not fail the session; the prompts stay untriaged so the next trigger tries again.

The key and the webhook URL are control-plane only. They are removed from the environment passed to Claude and Codex, and they are not placed in the Modal sandbox.

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

Claude is given a copy of the process environment with the triage key and webhook URL removed. `CLAUDE_CODE_OAUTH_TOKEN` is the subscription token. `ANTHROPIC_API_KEY` is the API key. `CLAUDE_CODE_USE_VERTEX=1` selects Vertex. On startup, if both the OAuth token and the API key are set, kennel warns that the API key wins.

If `model` is omitted on a Claude session, the adapter defaults to `opus` (the Agent SDK alias for the latest Opus). Set `KENNEL_CLAUDE_MODEL` in the runner environment to change that default, or pass `model` when creating the session.

## MCP and Grok Bot

The same tools are on `POST /mcp` and in the `kennel-mcp` package, which is a stdio MCP server aimed at `npx`:

```bash
export KENNEL_URL=http://127.0.0.1:8787
export KENNEL_TOKEN=...
npx kennel-mcp
```

Tools: `create_session`, `list_sessions`, `get_session`, `send_prompt`, `get_events` (`after`, `waitMs`, `includeRaw` default false, `types`, `limit`), `interrupt`, `stop`, `resume`, `finish_session`, `close_session`, `list_flags`, `ack_flag`, `get_summaries`, `digest`. `get_session` and `list_sessions` include `sessionSummary`, `lastBatchSummary`, and `openFlags`.

In Grok Bot, add a custom connector either as a remote MCP server (`http://<host>:8787/mcp` plus `Authorization: Bearer $KENNEL_TOKEN`; the startup log prints the connector shape with the token redacted) or as the stdio command `npx kennel-mcp` with `KENNEL_URL` and `KENNEL_TOKEN`.

## Security

`KENNEL_TOKEN` is the root password for this service. Anyone who has it can create sessions and run agents.

`permissionMode: "bypassPermissions"`, Codex `approvalPolicy: "never"`, and `sandbox: "danger-full-access"` let the agent run commands and write files as the sandbox user. On the local backend that user is the kennel host user, so the blast radius is the host. On Modal the blast radius is that sandbox plus whatever the Modal Secret can reach (GitHub, the model providers, and the repo). Do not put production cloud credentials, database passwords, or broad cloud IAM keys on the host or in the agent secret. Prefer a GitHub token that can push one fork, and a model credential that can only run the agent.

Bind the control plane to localhost and put TLS and a network policy in front if anything other than the orchestrator can route to it. The Modal tokens on the control plane can create sandboxes; treat them like the kennel token.

## Environment profiles

A profile teaches a session how to run a repo's tests. Profiles are YAML files in `KENNEL_ENV_DIR` (or `./environments` when that directory exists). Each one matches a repository URL and describes apt packages, language runtimes, local services, setup commands, check tiers, and cache directories. `environments/example.yaml` is a generic example. Keep real profiles outside this repository.

`kennel env build <profile>` hashes the lockfiles named in the profile at the repo's default branch and publishes a Modal image `kennel-env-<profile>-<hash>`. The build clones that commit, runs the setup commands, and snapshots the local database directory into the image. A changed lockfile produces a new hash, so the next build does not reuse the old image. The control plane does the same check when a session starts. If that image is missing or the lookup fails, the session uses `kennel-agent`, logs the reason, and can rebuild in the background (`KENNEL_ENV_AUTOBUILD=0` disables the rebuild). The session is not blocked on the build. A profile file that does not parse is logged and skipped so one bad file does not stop the service.

### Running a pull request's CI on Modal

`kennel env ci <profile> --branch <branch>` runs the profile's CI suite against one branch in a single Modal sandbox started from the profile's environment image, instead of on hosted CI runners. The suite is the ordered `ci:` list of check tiers in the profile (override with `--tiers a,b`). Each tier runs with its own timeout (`--timeout`, default 45 minutes); a failed `install` tier skips the rest. The sandbox is sized for the largest tier (`cpu`, `memoryMiB`), or `--cpu` and `--memory`. It gets the build secret (`KENNEL_BUILD_SECRET`, for the clone) and `KENNEL_MODAL_EXTRA_SECRETS`, never the agent secret. Output is a pass, fail, or timeout line per tier with test (vitest and bun test), tsc error, and biome error counts; logs go to `$KENNEL_DATA_DIR/ci/` and `--out result.json` writes the same as JSON. The exit code is 0 only when every tier passed.

```bash
KENNEL_ENV_DIR=/var/kennel/profiles KENNEL_MODAL_IMAGE=kennel-agent-v2 KENNEL_BUILD_SECRET=kennel-build \
  node packages/server/dist/index.js env ci tag --branch fix/ci-powerbi-and-sso-jit --out /tmp/ci.json
```

An agent in a kennel session can be asked to run the same suite: "Run `kennel env ci tag --branch <branch>` from the control plane, or in this sandbox run each tier in the profile's `ci:` list in order and report pass/fail and test counts per tier."

The image build does not receive the agent secret. It receives `REPO_URL`, `GIT_SHA`, and a GitHub token: `GITHUB_TOKEN` or `GH_TOKEN` from the process, or the Modal secret named by `KENNEL_BUILD_SECRET` when the process has neither. Build logs are printed with those secret values redacted. A failed build names the image id and the command `modal image logs <id>`.

On a matched image, the first sandbox for a session copies the database snapshot onto the session volume and starts the local services. Nothing in the profile should point at a remote database. The agent receives `KENNEL_TESTING.md` in the worktree and, for Claude, the same text appended to its system prompt. Check tiers can be any name. A tier with `default: true` is part of the gate that must pass; `fast` and `targeted` are in that gate when `default` is omitted. `finish` adds a Kennel checks section to the pull request body from `.kennel/checks.jsonl` and from commands seen in the session. Those paths are left out of the commit.

The sandbox size is the profile's `sandbox` block, or the larger of the `fast` and `targeted` tiers. The `full` tier can ask for more CPU and memory than the session has.

## Develop

```bash
npm test
npm run typecheck
```

Node 22. Tests cover the queue and boot recovery, SSE replay (`after` and `Last-Event-ID`), filtered events, the Claude and Codex adapters against fakes, the Modal backend against an in-process runner that speaks the real protocol, and triage against a mocked xAI endpoint. They do not call Modal, Claude, Codex, or xAI.

SQLite comes from `node:sqlite`. The start script disables the experimental warning.

## Layout

- `packages/core` — types, the prompt state machine, bearer check
- `packages/server` — HTTP, SSE, SQLite, sandboxes, adapters, `kennel-runner`
- `packages/mcp` — `kennel-mcp` stdio proxy
- `deploy/gcp/startup.sh` — control-plane VM
- `deploy/modal` — agent image
