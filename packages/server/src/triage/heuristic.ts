/** Cheap local check on the final assistant text. A match triggers a triage call; it does not itself raise a flag. */
export function heuristicHit(assistantText: string): boolean {
  const text = assistantText.trim();
  if (!text) return false;
  if (/\?\s*$/.test(text)) return true;
  return /\b(waiting for (?:your |the )?(?:input|approval|confirmation)|need(?:s|ed)? (?:your |an )?approval|rate[- ]limit|permission denied|not authenticated|please (?:log in|authenticate|approve)|awaiting (?:your |user )?input)\b/i.test(
    text,
  );
}

export function terminalTurn(status: string): boolean {
  return status === "failed" || status === "interrupted" || status === "error";
}

/** Assistant text of the turn that just finished. `events` is oldest-first and ends at this turn. */
export function finalAssistantText(events: Array<{ type: string; data: Record<string, unknown> }>): string {
  const parts: string[] = [];
  let skippedCurrent = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    if (event.type === "turn_completed") {
      if (!skippedCurrent) {
        skippedCurrent = true;
        continue;
      }
      break;
    }
    if (event.type === "message_delta" && typeof event.data.text === "string") parts.push(event.data.text);
  }
  return parts.reverse().join("");
}
