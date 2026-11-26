import {
  ATTENTION_KINDS,
  ATTENTION_SEVERITIES,
  type AttentionKind,
  type AttentionReason,
  type AttentionSeverity,
} from "@kennel/core";

export interface TriageVerdict {
  needsAttention: boolean;
  severity: AttentionSeverity;
  reasons: AttentionReason[];
  suggestedAction: string;
  batchSummary: string;
  sessionSummary: string;
}

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["needsAttention", "severity", "reasons", "suggestedAction", "batchSummary", "sessionSummary"],
  properties: {
    needsAttention: { type: "boolean" },
    severity: { type: "string", enum: [...ATTENTION_SEVERITIES] },
    reasons: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "summary", "evidence"],
        properties: {
          kind: { type: "string", enum: [...ATTENTION_KINDS] },
          summary: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
    suggestedAction: { type: "string" },
    batchSummary: { type: "string", description: "2-4 sentences covering the turns in this batch." },
    sessionSummary: { type: "string", description: "Updated session summary, at most 150 words." },
  },
} as const;

const SYSTEM = `You triage coding-agent sessions for a human orchestrator.
Return only the JSON object described by the schema.
batchSummary: 2-4 plain sentences covering every turn in the batch: what the agent did, files changed, commands or tests and their outcome, and the current state.
sessionSummary: rewrite the previous session summary plus this batch into at most 150 words of overall progress, open issues, and the next step.
needsAttention is true only when a person should look: the agent asked a question or is waiting, it is blocked, looping, tests failed, it took a risky action, it claimed success without evidence, it drifted from the request, or it errored.
severity:
- urgent: risky_action, secrets exposure, a destructive operation, or a session error.
- warn: the agent is blocked or waiting on a human (agent_question, blocked), stuck_or_looping, tests_failing, or claimed_done_unverified.
- info: everything else worth noting.
A question or a wait is never info. reasons cite short evidence from the transcript. suggestedAction is one sentence, or empty when needsAttention is false.`;

export interface XaiClientOptions {
  apiKey: string;
  model: string;
  /** Full chat-completions URL. Defaults to the public xAI endpoint. */
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

export class XaiClient {
  constructor(private readonly options: XaiClientOptions) {}

  /** One completion. Retries once, then throws. Never logs the API key. */
  async triage(input: { previousSummary: string | null; transcript: string }): Promise<TriageVerdict> {
    const user = [
      "PREVIOUS_SESSION_SUMMARY:",
      input.previousSummary?.trim() || "(none)",
      "",
      "BATCH_TRANSCRIPT:",
      input.transcript,
    ].join("\n");
    let lastError = "xai request failed";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.once(user);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }
    throw new Error(lastError);
  }

  private async once(user: string): Promise<TriageVerdict> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(this.options.endpoint ?? "https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.options.model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "kennel_attention", strict: true, schema: SCHEMA },
        },
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`xai ${response.status}: ${body.slice(0, 300)}`);
    }
    const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error("xai response had no content");
    return parseVerdict(content);
  }
}

/** A blocked or waiting agent is at least a warning, even if the model said info. */
export function floorSeverity(severity: AttentionSeverity, reasons: AttentionReason[]): AttentionSeverity {
  const waiting = reasons.some((reason) => reason.kind === "agent_question" || reason.kind === "blocked");
  if (waiting && severity === "info") return "warn";
  return severity;
}

export function parseVerdict(content: string): TriageVerdict {
  const parsed = JSON.parse(content) as Partial<TriageVerdict>;
  const reported = ATTENTION_SEVERITIES.includes(parsed.severity as AttentionSeverity)
    ? (parsed.severity as AttentionSeverity)
    : "info";
  const reasons = Array.isArray(parsed.reasons)
    ? parsed.reasons.filter((reason): reason is AttentionReason => {
        return (
          !!reason &&
          typeof reason === "object" &&
          ATTENTION_KINDS.includes((reason as AttentionReason).kind as AttentionKind) &&
          typeof (reason as AttentionReason).summary === "string" &&
          typeof (reason as AttentionReason).evidence === "string"
        );
      })
    : [];
  return {
    needsAttention: Boolean(parsed.needsAttention),
    severity: floorSeverity(reported, reasons),
    reasons,
    suggestedAction: typeof parsed.suggestedAction === "string" ? parsed.suggestedAction : "",
    batchSummary: typeof parsed.batchSummary === "string" ? parsed.batchSummary : "",
    sessionSummary: typeof parsed.sessionSummary === "string" ? parsed.sessionSummary : "",
  };
}
