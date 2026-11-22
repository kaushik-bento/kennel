import { createId, type KennelEventType } from "@kennel/core";
import type { KennelDb } from "../db.js";
import { limitWords, buildTranscript } from "./transcript.js";
import type { TriageVerdict, XaiClient } from "./xai.js";

export class AttentionService {
  constructor(
    private readonly db: KennelDb,
    private readonly client: XaiClient,
    private readonly publish: (sessionId: string, type: KennelEventType, data: Record<string, unknown>) => void,
    private readonly webhook?: string,
  ) {}

  /**
   * Review every finished prompt since the last successful triage.
   * Failures are logged and do not propagate.
   */
  async review(sessionId: string): Promise<void> {
    const session = this.db.getSession(sessionId);
    if (!session || session.deletedAt) return;
    const prompts = this.db.untriagedPrompts(sessionId);
    if (prompts.length === 0) return;
    const events = this.db.eventsAfter(sessionId, session.triageEventCursor, 500, { includeRaw: false });
    const snapshotCursor = events.at(-1)?.id ?? session.triageEventCursor;
    let verdict: TriageVerdict;
    try {
      verdict = await this.client.triage({
        previousSummary: session.sessionSummary,
        transcript: buildTranscript(prompts, events),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[kennel] triage_error session=${sessionId}: ${message}`);
      return;
    }
    const sessionSummary = limitWords(verdict.sessionSummary, 150);
    const batchSummary = verdict.batchSummary.trim();
    const now = new Date().toISOString();
    const fromPromptId = prompts[0]?.id ?? null;
    const toPromptId = prompts.at(-1)?.id ?? null;
    if (batchSummary) {
      this.db.insertSummary({
        id: createId(),
        sessionId,
        fromPromptId,
        toPromptId,
        summary: batchSummary,
        createdAt: now,
      });
    }
    if (sessionSummary) this.db.setSessionSummary(sessionId, sessionSummary);
    this.db.markPromptsTriaged(prompts.map((prompt) => prompt.id));
    this.db.setTriageCursor(sessionId, snapshotCursor);
    if (!verdict.needsAttention) return;
    const flagId = createId();
    this.db.insertFlag({
      id: flagId,
      sessionId,
      promptId: toPromptId,
      severity: verdict.severity,
      reasons: verdict.reasons,
      suggestedAction: verdict.suggestedAction,
      createdAt: now,
      acknowledgedAt: null,
    });
    const data = {
      flagId,
      promptId: toPromptId,
      fromPromptId,
      severity: verdict.severity,
      reasons: verdict.reasons,
      suggestedAction: verdict.suggestedAction,
      batchSummary,
      sessionSummary,
    };
    this.publish(sessionId, "attention", data);
    if (this.webhook) {
      void postWebhook(this.webhook, { sessionId, ...data }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[kennel] attention webhook failed: ${message}`);
      });
    }
  }
}

async function postWebhook(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`webhook ${response.status}`);
}
