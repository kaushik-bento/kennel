#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HttpKennelClient } from "./client.js";
import { registerKennelTools } from "./register.js";

export { HttpKennelClient } from "./client.js";
export { registerKennelTools } from "./register.js";

async function main(): Promise<void> {
  const token = process.env.KENNEL_TOKEN;
  if (!token) {
    console.error("KENNEL_TOKEN is required");
    process.exit(1);
  }
  const baseUrl = process.env.KENNEL_URL ?? "http://127.0.0.1:8787";
  const server = new McpServer({ name: "kennel", version: "0.1.0" });
  registerKennelTools(server, new HttpKennelClient(baseUrl, token));
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
