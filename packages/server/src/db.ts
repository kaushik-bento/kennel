import { DatabaseSync } from "node:sqlite";
import type { AgentKind, KennelEvent, KennelEventType, Permissions, SandboxBackendKind, SessionState } from "@kennel/core";

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
    `);
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

  eventsAfter(sessionId: string, after: number, limit: number): KennelEvent[] {
    const rows = this.db
      .prepare(
        `SELECT id, session_id, type, data_json, raw_json, created_at FROM events
         WHERE session_id = ? AND id > ? ORDER BY id ASC LIMIT ?`,
      )
      .all(sessionId, after, limit) as unknown as Array<{
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
}
