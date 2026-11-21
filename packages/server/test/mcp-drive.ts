/**
 * Drives the MCP client outside the node:test runner. The runner's async hooks
 * stall StreamableHTTPClientTransport's response parser; a child process does not.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const base = process.env.KENNEL_BASE ?? "";
const token = process.env.KENNEL_TOKEN ?? "";
const repo = process.env.KENNEL_REPO ?? "";
const mcpEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../mcp/src/index.ts");

const httpClient = new Client({ name: "kennel-test", version: "0.0.0" });
await httpClient.connect(
  new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  }),
);
const listed = await httpClient.listTools();
const names = listed.tools.map((tool) => tool.name).sort();
const expected = [
  "close_session",
  "create_session",
  "finish_session",
  "get_events",
  "get_session",
  "interrupt",
  "list_sessions",
  "resume",
  "send_prompt",
  "stop",
];
if (JSON.stringify(names) !== JSON.stringify(expected)) {
  console.error("tools", names);
  process.exit(1);
}
const created = await httpClient.callTool({
  name: "create_session",
  arguments: { repo, baseBranch: "main", agent: "echo" },
});
const session = JSON.parse((created.content as Array<{ text: string }>)[0]!.text) as { id: string };
await httpClient.callTool({
  name: "send_prompt",
  arguments: { sessionId: session.id, text: "via mcp", mode: "queue" },
});
let cursor = 0;
let sawEcho = false;
for (let attempt = 0; attempt < 10 && !sawEcho; attempt += 1) {
  const events = await httpClient.callTool({
    name: "get_events",
    arguments: { sessionId: session.id, after: cursor, waitMs: 500 },
  });
  const page = JSON.parse((events.content as Array<{ text: string }>)[0]!.text) as {
    cursor: number;
    events: Array<{ data: { result?: string } }>;
  };
  cursor = page.cursor;
  sawEcho = page.events.some((event) => event.data.result === "echo:via mcp");
}
if (!sawEcho) {
  console.error("echo result did not arrive");
  process.exit(1);
}
await httpClient.close();

const stdio = new Client({ name: "kennel-stdio-test", version: "0.0.0" });
await stdio.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", mcpEntry],
    env: { ...process.env, KENNEL_URL: base, KENNEL_TOKEN: token },
  }),
);
const proxied = await stdio.callTool({ name: "list_sessions", arguments: {} });
const sessions = JSON.parse((proxied.content as Array<{ text: string }>)[0]!.text) as Array<{ id: string }>;
if (!sessions.some((item) => item.id === session.id)) {
  console.error("stdio sessions", sessions);
  process.exit(1);
}
await stdio.close();
console.log("ok");
