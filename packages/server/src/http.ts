import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { bearerAuthorized } from "@kennel/core";
import { createSessionSchema, finishSchema, sendPromptSchema } from "@kennel/core";
import type { KennelConfig } from "./config.js";
import { KennelError } from "./errors.js";
import { handleMcp } from "./mcp-http.js";
import type { SessionManager } from "./manager.js";

const BODY_LIMIT = 1_000_000;

export function createHttpServer(config: KennelConfig, manager: SessionManager) {
  return createServer((req, res) => {
    void handle(config, manager, req, res);
  });
}

async function handle(
  config: KennelConfig,
  manager: SessionManager,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    if (!bearerAuthorized(req.headers.authorization, config.token)) {
      send(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname.replace(/\/$/, "") || "/";
    const method = req.method ?? "GET";

    if (path === "/mcp") {
      const body = method === "GET" || method === "DELETE" ? undefined : await readJson(req);
      await handleMcp(req, res, body, manager);
      return;
    }
    if (method === "GET" && path === "/health") {
      send(res, 200, { ok: true, service: "kennel" });
      return;
    }
    if (method === "POST" && path === "/sessions") {
      const parsed = createSessionSchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { error: formatZod(parsed.error.issues) });
      const session = await manager.createSession(parsed.data);
      send(res, 201, session);
      return;
    }
    if (method === "GET" && path === "/sessions") {
      send(res, 200, { sessions: await manager.listSessions() });
      return;
    }

    const sessionMatch = /^\/sessions\/([^/]+)$/.exec(path);
    const nested = /^\/sessions\/([^/]+)\/([^/]+)$/.exec(path);
    if (method === "GET" && sessionMatch?.[1]) {
      send(res, 200, await manager.getSession(decodeURIComponent(sessionMatch[1])));
      return;
    }
    if (method === "DELETE" && sessionMatch?.[1]) {
      const cleanup = url.searchParams.get("cleanup") !== "false";
      send(res, 200, await manager.closeSession(decodeURIComponent(sessionMatch[1]), { cleanup }));
      return;
    }
    if (!nested?.[1] || !nested[2]) {
      send(res, 404, { error: "not found" });
      return;
    }
    const id = decodeURIComponent(nested[1]);
    const action = nested[2];
    if (method === "POST" && action === "prompts") {
      const parsed = sendPromptSchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { error: formatZod(parsed.error.issues) });
      send(res, 202, await manager.sendPrompt(id, parsed.data));
      return;
    }
    if (method === "GET" && action === "events") {
      const after = parseAfter(url, req);
      const accept = req.headers.accept ?? "";
      const wantsJson = accept.includes("application/json") && !accept.includes("text/event-stream");
      if (wantsJson) {
        const waitMs = Number(url.searchParams.get("waitMs") ?? "0");
        if (!Number.isFinite(waitMs) || waitMs < 0) return send(res, 400, { error: "invalid waitMs" });
        send(res, 200, await manager.getEvents(id, { after, waitMs }));
        return;
      }
      await writeSse(manager, id, after, req, res);
      return;
    }
    if (method === "POST" && action === "interrupt") {
      send(res, 200, await manager.interrupt(id));
      return;
    }
    if (method === "POST" && action === "stop") {
      send(res, 200, await manager.stop(id));
      return;
    }
    if (method === "POST" && action === "resume") {
      send(res, 200, await manager.resume(id));
      return;
    }
    if (method === "POST" && action === "finish") {
      const parsed = finishSchema.safeParse(await readJson(req));
      if (!parsed.success) return send(res, 400, { error: formatZod(parsed.error.issues) });
      send(res, 200, await manager.finishSession(id, parsed.data));
      return;
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    if (err instanceof KennelError) {
      send(res, err.status, { error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : "internal error";
    send(res, 500, { error: message });
  }
}

function parseAfter(url: URL, req: IncomingMessage): number {
  const query = url.searchParams.get("after");
  const header = req.headers["last-event-id"];
  const raw = query ?? (Array.isArray(header) ? header[0] : header) ?? "0";
  const after = Number(raw);
  if (!Number.isInteger(after) || after < 0) {
    throw new KennelError(400, "invalid event cursor");
  }
  return after;
}

async function writeSse(
  manager: SessionManager,
  id: string,
  after: number,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.on("close", abort);
  res.write(": connected\n\n");
  try {
    for await (const event of manager.streamEvents(id, after, controller.signal)) {
      res.write(`id: ${event.id}\n`);
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      const message = err instanceof Error ? err.message : "stream failed";
      res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
    }
  } finally {
    req.off("close", abort);
    if (!res.writableEnded) res.end();
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > BODY_LIMIT) throw new KennelError(413, "body too large");
    chunks.push(buf);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new KennelError(400, "invalid json");
  }
}

function formatZod(issues: Array<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
}
