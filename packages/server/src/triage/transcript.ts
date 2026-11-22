import type { KennelEvent } from "@kennel/core";

const MAX_CHARS = 30_000;
const FIELD_CAP = 400;

export interface TranscriptPrompt {
  id: string;
  text: string;
  status: string;
}

export function buildTranscript(prompts: TranscriptPrompt[], events: KennelEvent[]): string {
  const lines: string[] = [];
  for (const prompt of prompts) {
    lines.push(`PROMPT ${prompt.id} (${prompt.status}): ${clip(prompt.text, 2000)}`);
  }
  let assistant = "";
  const flush = () => {
    if (!assistant) return;
    lines.push(`ASSISTANT: ${clip(assistant, 4000)}`);
    assistant = "";
  };
  for (const event of events) {
    if (event.type === "message_delta" && typeof event.data.text === "string") {
      assistant += event.data.text;
      continue;
    }
    flush();
    if (event.type === "tool_call") {
      lines.push(`TOOL ${String(event.data.name ?? "tool")} input: ${clip(JSON.stringify(event.data.input ?? {}), FIELD_CAP)}`);
    } else if (event.type === "tool_result") {
      lines.push(
        `TOOL RESULT ${String(event.data.name ?? "")} error=${String(event.data.isError ?? false)}: ${clip(JSON.stringify(event.data.output ?? ""), FIELD_CAP)}`,
      );
    } else if (event.type === "turn_completed") {
      lines.push(`TURN ${String(event.data.status ?? "completed")} prompt=${String(event.data.promptId ?? "")}`);
    } else if (event.type === "error") {
      lines.push(`ERROR: ${clip(String(event.data.message ?? ""), FIELD_CAP)}`);
    }
  }
  flush();
  return capHeadTail(lines.join("\n"), MAX_CHARS);
}

function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

export function capHeadTail(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = "\n...[truncated]...\n";
  const head = Math.floor(max * 0.7);
  const tail = Math.max(0, max - head - marker.length);
  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

export function limitWords(text: string, words: number): string {
  const parts = text.trim().split(/\s+/);
  if (parts.length <= words) return text.trim();
  return parts.slice(0, words).join(" ");
}
