export const FRAME_PREFIX = "KENNEL\t";

export interface RpcRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { message: string };
}

export interface RpcEvent {
  method: "event" | "native";
  params: Record<string, unknown>;
}

export function encodeFrame(message: unknown): string {
  return `${FRAME_PREFIX}${JSON.stringify(message)}\n`;
}

export function decodeFrame(line: string): RpcRequest | RpcResponse | RpcEvent | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith(FRAME_PREFIX)) return null;
  try {
    return JSON.parse(trimmed.slice(FRAME_PREFIX.length)) as RpcRequest | RpcResponse | RpcEvent;
  } catch {
    return null;
  }
}

export async function* iterateLines(chunks: AsyncIterable<string | Buffer>): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) yield buffer;
}
