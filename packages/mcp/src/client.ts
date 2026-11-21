import type {
  CreateSessionInput,
  EventPage,
  FinishInput,
  FinishResult,
  KennelApi,
  PromptResult,
  SendPromptInput,
  SessionView,
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

  getEvents(id: string, opts: { after?: number; waitMs?: number }): Promise<EventPage> {
    const params = new URLSearchParams();
    params.set("after", String(opts.after ?? 0));
    if (opts.waitMs !== undefined) params.set("waitMs", String(opts.waitMs));
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
