import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerKennelTools } from "kennel-mcp/register";
import type { KennelApi } from "@kennel/core";

/**
 * Stateless streamable HTTP. A fresh server and transport are created per
 * request so concurrent clients do not share JSON-RPC ids.
 */
export async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  api: KennelApi,
): Promise<void> {
  const server = new McpServer({ name: "kennel", version: "0.1.0" });
  registerKennelTools(server, api);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close().catch(() => undefined);
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
