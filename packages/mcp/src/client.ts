import type {
  CreateSessionInput,
  DigestEntry,
  EventPage,
  EventQuery,
  FinishInput,
  FinishResult,
  FlagView,
  KennelApi,
  PromptResult,
  SendPromptInput,
  SessionView,
  SummaryView,
} from "@kennel/core";

export class KennelHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "KennelHttpError";
  }
}

/** HTTP client for a kennel server. Used by the stdio MCP proxy. */
export class HttpKennelClient implements KennelApi {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  createSession(input: CreateSessionInput): Promise<SessionView> {
    return this.request("POST", "/sessions", input);
  }

  async listSessions(): Promise<SessionView[]> {
    const body = await this.request<{ sessions: SessionView[] }>("GET", "/sessions");
    return body.sessions;
  }

  getSession(id: string): Promise<SessionView> {
    return this.request("GET", `/sessions/${encodeURIComponent(id)}`);
  }

  sendPrompt(id: string, input: SendPromptInput): Promise<PromptResult> {
    return this.request("POST", `/sessions/${encodeURIComponent(id)}/prompts`, input);
  }

  getEvents(id: string, opts: EventQuery): Promise<EventPage> {
    const params = new URLSearchParams();
    params.set("after", String(opts.after ?? 0));
    if (opts.waitMs !== undefined) params.set("waitMs", String(opts.waitMs));
    if (opts.includeRaw) params.set("raw", "1");
    if (opts.types && opts.types.length > 0) params.set("types", opts.types.join(","));
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    return this.request(
      "GET",
      `/sessions/${encodeURIComponent(id)}/events?${params.toString()}`,
      undefined,
      { Accept: "application/json" },
    );
  }

  interrupt(id: string): Promise<SessionView> {
    return this.request("POST", `/sessions/${encodeURIComponent(id)}/interrupt`, {});
  }

  stop(id: string): Promise<SessionView> {
    return this.request("POST", `/sessions/${encodeURIComponent(id)}/stop`, {});
  }

  resume(id: string): Promise<SessionView> {
    return this.request("POST", `/sessions/${encodeURIComponent(id)}/resume`, {});
  }

  finishSession(id: string, input: FinishInput): Promise<FinishResult> {
    return this.request("POST", `/sessions/${encodeURIComponent(id)}/finish`, input);
  }

  closeSession(id: string, opts?: { cleanup?: boolean }): Promise<{ deleted: true; cleanup: boolean }> {
    const cleanup = opts?.cleanup === false ? "?cleanup=false" : "";
    return this.request("DELETE", `/sessions/${encodeURIComponent(id)}${cleanup}`);
  }

  async listFlags(opts: { sessionId?: string; unacknowledgedOnly?: boolean; minSeverity?: FlagView["severity"] }): Promise<FlagView[]> {
    const params = new URLSearchParams();
    if (opts.sessionId) params.set("sessionId", opts.sessionId);
    if (opts.unacknowledgedOnly === false) params.set("unacknowledged", "false");
    if (opts.minSeverity) params.set("minSeverity", opts.minSeverity);
    const body = await this.request<{ flags: FlagView[] }>("GET", `/flags?${params.toString()}`);
    return body.flags;
  }

  ackFlag(id: string): Promise<FlagView> {
    return this.request("POST", `/flags/${encodeURIComponent(id)}/ack`, {});
  }

  async getSummaries(sessionId: string, opts?: { limit?: number }): Promise<SummaryView[]> {
    const params = new URLSearchParams();
    if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
    const body = await this.request<{ summaries: SummaryView[] }>(
      "GET",
      `/sessions/${encodeURIComponent(sessionId)}/summaries?${params.toString()}`,
    );
    return body.summaries;
  }

  async digest(): Promise<DigestEntry[]> {
    const body = await this.request<{ sessions: DigestEntry[] }>("GET", "/digest");
    return body.sessions;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = { error: text };
      }
    }
    if (!response.ok) {
      const message =
        parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string"
          ? parsed.error
          : text || response.statusText;
      throw new KennelHttpError(response.status, message);
    }
    return parsed as T;
  }
}
