import { DatabaseSync } from "node:sqlite";
import type {
  AgentKind,
  AttentionReason,
  AttentionSeverity,
  FlagView,
  KennelEvent,
  KennelEventType,
  Permissions,
  SandboxBackendKind,
  SessionState,
  SummaryView,
} from "@kennel/core";

const originalEmitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: unknown, ...args: unknown[]) => {
  const message = typeof warning === "string" ? warning : warning instanceof Error ? warning.message : "";
  if (message.includes("SQLite is an experimental feature")) return;
  return Reflect.apply(originalEmitWarning, process, [warning, ...args]);
}) as typeof process.emitWarning;

export interface SessionRow {
  id: string;
  agent: AgentKind;
  repo: string;
  baseBranch: string;
  branch: string;
  worktreePath: string;
  sourcePath: string;
  backend: SandboxBackendKind;
  sandboxId: string | null;
  volumeName: string | null;
  state: SessionState;
  nativeSessionId: string | null;
  model: string | null;
  permissions: Permissions;
  error: string | null;
  sessionSummary: string | null;
  triageEventCursor: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface PromptRow {
  id: string;
  sessionId: string;
  text: string;
  mode: "queue" | "steer";
  status: "queued" | "running" | "done" | "interrupted" | "cancelled" | "error";
  position: number;
}

interface SessionSql {
  id: string;
  agent: AgentKind;
  repo: string;
  base_branch: string;
  branch: string;
  worktree_path: string;
  source_path: string;
  backend: SandboxBackendKind;
  sandbox_id: string | null;
  volume_name: string | null;
  state: SessionState;
  native_session_id: string | null;
  model: string | null;
  permissions_json: string;
  error: string | null;
  session_summary: string | null;
  triage_event_cursor: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function mapSession(row: SessionSql): SessionRow {
  return {
    id: row.id,
    agent: row.agent,
    repo: row.repo,
    baseBranch: row.base_branch,
    branch: row.branch,
    worktreePath: row.worktree_path,
    sourcePath: row.source_path,
    backend: row.backend,
    sandboxId: row.sandbox_id,
    volumeName: row.volume_name,
    state: row.state,
    nativeSessionId: row.native_session_id,
    model: row.model,
    permissions: JSON.parse(row.permissions_json) as Permissions,
    error: row.error,
    sessionSummary: row.session_summary,
    triageEventCursor: Number(row.triage_event_cursor ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function safeJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ unserializable: true });
  }
}

export class KennelDb {
  constructor(private readonly db: DatabaseSync) {}

  static open(file: string): KennelDb {
    const db = new DatabaseSync(file);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        agent TEXT NOT NULL,
        repo TEXT NOT NULL,
        base_branch TEXT NOT NULL,
        branch TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        source_path TEXT NOT NULL,
        backend TEXT NOT NULL DEFAULT 'local',
        sandbox_id TEXT,
        volume_name TEXT,
        state TEXT NOT NULL,
        native_session_id TEXT,
        model TEXT,
        permissions_json TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS prompts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        text TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );
      CREATE INDEX IF NOT EXISTS prompts_session_status ON prompts(session_id, status, position);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        data_json TEXT NOT NULL,
        raw_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_session_id ON events(session_id, id);
      CREATE TABLE IF NOT EXISTS flags (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        prompt_id TEXT,
        severity TEXT NOT NULL,
        reasons_json TEXT NOT NULL,
        suggested_action TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        acknowledged_at TEXT
      );
      CREATE INDEX IF NOT EXISTS flags_session ON flags(session_id, created_at);
      CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        from_prompt_id TEXT,
        to_prompt_id TEXT,
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS summaries_session ON summaries(session_id, created_at);
    `);
    ensureColumn(db, "sessions", "session_summary", "TEXT");
    ensureColumn(db, "sessions", "triage_event_cursor", "INTEGER NOT NULL DEFAULT 0");
    ensureColumn(db, "prompts", "triaged", "INTEGER NOT NULL DEFAULT 0");
    return new KennelDb(db);
  }

  close(): void {
    this.db.close();
  }

  insertSession(row: SessionRow): void {
    this.db
      .prepare(
        `INSERT INTO sessions (
          id, agent, repo, base_branch, branch, worktree_path, source_path, backend, sandbox_id, volume_name, state,
          native_session_id, model, permissions_json, error, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        row.id,
        row.agent,
        row.repo,
        row.baseBranch,
        row.branch,
        row.worktreePath,
        row.sourcePath,
        row.backend,
        row.sandboxId,
        row.volumeName,
        row.state,
        row.nativeSessionId,
        row.model,
        JSON.stringify(row.permissions),
        row.error,
        row.createdAt,
        row.updatedAt,
      );
  }

  getSession(id: string): SessionRow | undefined {
    const row = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionSql | undefined;
    return row ? mapSession(row) : undefined;
  }

  listSessions(): SessionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE deleted_at IS NULL ORDER BY created_at DESC`)
      .all() as unknown as SessionSql[];
    return rows.map(mapSession);
  }

  listActive(): SessionRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM sessions WHERE deleted_at IS NULL`)
      .all() as unknown as SessionSql[];
    return rows.map(mapSession);
  }

  setState(id: string, state: SessionState, error: string | null = null): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE sessions SET state = ?, error = ?, updated_at = ? WHERE id = ?`)
      .run(state, error, now, id);
  }

  setSandboxId(id: string, sandboxId: string | null): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE sessions SET sandbox_id = ?, updated_at = ? WHERE id = ?`).run(sandboxId, now, id);
  }

  setNativeSessionId(id: string, nativeSessionId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE sessions SET native_session_id = ?, updated_at = ? WHERE id = ? AND (native_session_id IS NULL OR native_session_id != ?)`,
      )
      .run(nativeSessionId, now, id, nativeSessionId);
  }

  markDeleted(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE sessions SET deleted_at = ?, updated_at = ?, state = 'stopped' WHERE id = ?`).run(now, now, id);
  }

  countRunning(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE deleted_at IS NULL AND state = 'running'`)
      .get() as { n: number };
    return Number(row.n);
  }

  queueDepth(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM prompts WHERE session_id = ? AND status = 'queued'`)
      .get(sessionId) as { n: number };
    return Number(row.n);
  }

  nextPosition(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(position), 0) AS n FROM prompts WHERE session_id = ?`)
      .get(sessionId) as { n: number };
    return Number(row.n) + 1;
  }

  insertPrompt(prompt: PromptRow): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO prompts (id, session_id, text, mode, status, position, created_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        prompt.id,
        prompt.sessionId,
        prompt.text,
        prompt.mode,
        prompt.status,
        prompt.position,
        now,
        prompt.status === "running" || prompt.status === "done" ? now : null,
        prompt.status === "done" || prompt.status === "cancelled" || prompt.status === "error" ? now : null,
      );
  }

  markPromptRunning(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE prompts SET status = 'running', started_at = ? WHERE id = ?`).run(now, id);
  }

  finishPrompt(id: string, status: PromptRow["status"]): void {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE prompts SET status = ?, finished_at = ? WHERE id = ?`).run(status, now, id);
  }

  nextQueuedPrompt(sessionId: string): PromptRow | undefined {
    const row = this.db
      .prepare(
        `SELECT id, session_id, text, mode, status, position FROM prompts
         WHERE session_id = ? AND status = 'queued' ORDER BY position ASC LIMIT 1`,
      )
      .get(sessionId) as
      | { id: string; session_id: string; text: string; mode: "queue" | "steer"; status: PromptRow["status"]; position: number }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      sessionId: row.session_id,
      text: row.text,
      mode: row.mode,
      status: row.status,
      position: row.position,
    };
  }

  cancelQueued(sessionId: string): number {
    const now = new Date().toISOString();
    const result = this.db
      .prepare(`UPDATE prompts SET status = 'cancelled', finished_at = ? WHERE session_id = ? AND status = 'queued'`)
      .run(now, sessionId);
    return Number(result.changes);
  }

  finishRunning(sessionId: string, status: PromptRow["status"]): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE prompts SET status = ?, finished_at = ? WHERE session_id = ? AND status = 'running'`)
      .run(status, now, sessionId);
  }

  requeueRunning(sessionId: string): void {
    this.db
      .prepare(`UPDATE prompts SET status = 'queued', started_at = NULL, finished_at = NULL WHERE session_id = ? AND status = 'running'`)
      .run(sessionId);
  }

  appendEvent(input: {
    sessionId: string;
    type: KennelEventType;
    data: Record<string, unknown>;
    raw?: unknown;
  }): KennelEvent {
    const createdAt = new Date().toISOString();
    const result = this.db
      .prepare(`INSERT INTO events (session_id, type, data_json, raw_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(input.sessionId, input.type, JSON.stringify(input.data), safeJson(input.raw), createdAt);
    const id = Number(result.lastInsertRowid);
    const event: KennelEvent = {
      id,
      sessionId: input.sessionId,
      type: input.type,
      createdAt,
      data: input.data,
    };
    if (input.raw !== undefined) event.raw = input.raw;
    return event;
  }

  eventsAfter(
    sessionId: string,
    after: number,
    limit: number,
    opts?: { types?: KennelEventType[]; includeRaw?: boolean },
  ): KennelEvent[] {
    const includeRaw = opts?.includeRaw !== false;
    const types = opts?.types?.filter((type) => type.length > 0) ?? [];
    const typeClause = types.length > 0 ? ` AND type IN (${types.map(() => "?").join(",")})` : "";
    const rawColumn = includeRaw ? "raw_json" : "NULL AS raw_json";
    const rows = this.db
      .prepare(
        `SELECT id, session_id, type, data_json, ${rawColumn}, created_at FROM events
         WHERE session_id = ? AND id > ?${typeClause} ORDER BY id ASC LIMIT ?`,
      )
      .all(sessionId, after, ...types, limit) as unknown as Array<{
      id: number;
      session_id: string;
      type: KennelEventType;
      data_json: string;
      raw_json: string | null;
      created_at: string;
    }>;
    return rows.map((row) => {
      const event: KennelEvent = {
        id: Number(row.id),
        sessionId: row.session_id,
        type: row.type,
        createdAt: row.created_at,
        data: JSON.parse(row.data_json) as Record<string, unknown>,
      };
      if (row.raw_json) event.raw = JSON.parse(row.raw_json) as unknown;
      return event;
    });
  }

  latestEventId(sessionId: string): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS n FROM events WHERE session_id = ?`).get(sessionId) as {
      n: number;
    };
    return Number(row.n);
  }

  untriagedPrompts(sessionId: string): Array<{ id: string; text: string; status: string; position: number }> {
    return this.db
      .prepare(
        `SELECT id, text, status, position FROM prompts
         WHERE session_id = ? AND triaged = 0 AND status IN ('done', 'interrupted', 'error')
         ORDER BY position ASC`,
      )
      .all(sessionId) as unknown as Array<{ id: string; text: string; status: string; position: number }>;
  }

  markPromptsTriaged(ids: string[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`UPDATE prompts SET triaged = 1 WHERE id = ?`);
    for (const id of ids) stmt.run(id);
  }

  setTriageCursor(sessionId: string, cursor: number): void {
    this.db.prepare(`UPDATE sessions SET triage_event_cursor = ?, updated_at = ? WHERE id = ?`).run(cursor, new Date().toISOString(), sessionId);
  }

  setSessionSummary(sessionId: string, summary: string): void {
    this.db.prepare(`UPDATE sessions SET session_summary = ?, updated_at = ? WHERE id = ?`).run(summary, new Date().toISOString(), sessionId);
  }

  insertSummary(row: SummaryView): void {
    this.db
      .prepare(
        `INSERT INTO summaries (id, session_id, from_prompt_id, to_prompt_id, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(row.id, row.sessionId, row.fromPromptId, row.toPromptId, row.summary, row.createdAt);
  }

  listSummaries(sessionId: string, limit: number): SummaryView[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, from_prompt_id, to_prompt_id, summary, created_at FROM summaries
         WHERE session_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sessionId, limit) as unknown as Array<{
      id: string;
      session_id: string;
      from_prompt_id: string | null;
      to_prompt_id: string | null;
      summary: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      fromPromptId: row.from_prompt_id,
      toPromptId: row.to_prompt_id,
      summary: row.summary,
      createdAt: row.created_at,
    }));
  }

  latestSummary(sessionId: string): string | null {
    const row = this.db
      .prepare(`SELECT summary FROM summaries WHERE session_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(sessionId) as { summary: string } | undefined;
    return row?.summary ?? null;
  }

  insertFlag(row: FlagView): void {
    this.db
      .prepare(
        `INSERT INTO flags (id, session_id, prompt_id, severity, reasons_json, suggested_action, created_at, acknowledged_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(row.id, row.sessionId, row.promptId, row.severity, JSON.stringify(row.reasons), row.suggestedAction, row.createdAt);
  }

  listFlags(opts: { sessionId?: string; unacknowledgedOnly?: boolean; minSeverity?: AttentionSeverity }): FlagView[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (opts.sessionId) {
      where.push("session_id = ?");
      args.push(opts.sessionId);
    }
    if (opts.unacknowledgedOnly) where.push("acknowledged_at IS NULL");
    const sql = `SELECT * FROM flags ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`;
    const rows = this.db.prepare(sql).all(...args) as unknown as FlagSql[];
    const min = opts.minSeverity ? SEVERITY_RANK[opts.minSeverity] : 0;
    return rows.map(mapFlag).filter((flag) => SEVERITY_RANK[flag.severity] >= min);
  }

  ackFlag(id: string): FlagView | undefined {
    const now = new Date().toISOString();
    this.db.prepare(`UPDATE flags SET acknowledged_at = ? WHERE id = ? AND acknowledged_at IS NULL`).run(now, id);
    const row = this.db.prepare(`SELECT * FROM flags WHERE id = ?`).get(id) as FlagSql | undefined;
    return row ? mapFlag(row) : undefined;
  }

  countOpenFlags(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM flags WHERE session_id = ? AND acknowledged_at IS NULL`)
      .get(sessionId) as { n: number };
    return Number(row.n);
  }

  highestOpenSeverity(sessionId: string): AttentionSeverity | null {
    const rows = this.db
      .prepare(`SELECT severity FROM flags WHERE session_id = ? AND acknowledged_at IS NULL`)
      .all(sessionId) as unknown as Array<{ severity: AttentionSeverity }>;
    let best: AttentionSeverity | null = null;
    for (const row of rows) {
      if (!best || SEVERITY_RANK[row.severity] > SEVERITY_RANK[best]) best = row.severity;
    }
    return best;
  }
}

const SEVERITY_RANK: Record<AttentionSeverity, number> = { info: 1, warn: 2, urgent: 3 };

interface FlagSql {
  id: string;
  session_id: string;
  prompt_id: string | null;
  severity: AttentionSeverity;
  reasons_json: string;
  suggested_action: string;
  created_at: string;
  acknowledged_at: string | null;
}

function mapFlag(row: FlagSql): FlagView {
  return {
    id: row.id,
    sessionId: row.session_id,
    promptId: row.prompt_id,
    severity: row.severity,
    reasons: JSON.parse(row.reasons_json) as AttentionReason[],
    suggestedAction: row.suggested_action,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at,
  };
}

function ensureColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (!cols.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
