import assert from "node:assert/strict";
import { createServer } from "node:http";
import { describe, it } from "node:test";
import { HttpKennelClient } from "../src/client.js";

describe("HttpKennelClient", () => {
  it("sends the bearer token and surfaces error bodies", async () => {
    const server = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer tok") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessions: [{ id: "abc" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    try {
      const client = new HttpKennelClient(`http://127.0.0.1:${address.port}`, "tok");
      const sessions = await client.listSessions();
      assert.equal(sessions[0]?.id, "abc");
      const denied = new HttpKennelClient(`http://127.0.0.1:${address.port}`, "nope");
      await assert.rejects(denied.listSessions(), /unauthorized/);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  });
});
