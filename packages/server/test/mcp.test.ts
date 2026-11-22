import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { TOKEN, startApp } from "./helpers.js";

const drive = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "mcp-drive.ts");

describe("mcp surfaces", () => {
  it("exposes the tools over streamable HTTP and the stdio proxy", async () => {
    const app = await startApp({ echoDelayMs: 10 });
    try {
      const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "--import", "tsx", drive], {
        env: {
          ...process.env,
          KENNEL_BASE: app.base,
          KENNEL_TOKEN: TOKEN,
          KENNEL_REPO: app.repo,
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
      assert.equal(code, 0, `${stdout}\n${stderr}`);
      assert.match(stdout, /ok/);
    } finally {
      await app.stop();
    }
  });

  it("rejects /mcp without the bearer token", async () => {
    const app = await startApp();
    try {
      const response = await fetch(`${app.base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      });
      assert.equal(response.status, 401);
    } finally {
      await app.stop();
    }
  });
});
