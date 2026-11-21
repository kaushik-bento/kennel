import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readSse, startApp, waitFor } from "./helpers.js";

describe("sse replay", () => {
  it("replays with after and Last-Event-ID, then streams a new turn", async () => {
    const app = await startApp({ echoDelayMs: 15 });
    try {
      const created = await app.api("POST", "/sessions", { repo: app.repo, baseBranch: "main", agent: "echo" });
      const id = created.body.id as string;
      await app.api("POST", `/sessions/${id}/prompts`, { text: "one", mode: "queue" });
      await waitFor(async () => (await app.api("GET", `/sessions/${id}`)).body.state === "idle");

      const all: Array<{ id: number; type: string }> = [];
      await readSse(app.base, `/sessions/${id}/events?after=0`, (event) => {
        if (event.data?.type) all.push({ id: event.data.id, type: event.data.type });
        if (event.data?.type === "turn_completed") return "stop";
        return undefined;
      });
      assert.ok(all.length >= 2);
      for (let i = 1; i < all.length; i++) assert.ok(all[i]!.id > all[i - 1]!.id);
      const firstId = all[0]!.id;

      const replayed: number[] = [];
      await readSse(
        app.base,
        `/sessions/${id}/events`,
        (event) => {
          if (!event.data?.id) return undefined;
          replayed.push(event.data.id);
          if (event.data.type === "turn_completed") return "stop";
          return undefined;
        },
        { "Last-Event-ID": String(firstId) },
      );
      assert.ok(replayed.every((eventId) => eventId > firstId));
      assert.equal(replayed.includes(firstId), false);

      const live = readSse(app.base, `/sessions/${id}/events?after=${all.at(-1)!.id}`, (event) => {
        if (event.data?.data?.result === "echo:two") return "stop";
        return undefined;
      });
      await app.api("POST", `/sessions/${id}/prompts`, { text: "two", mode: "queue" });
      await live;
    } finally {
      await app.stop();
    }
  });

  it("long-polls the JSON event endpoint", async () => {
    const app = await startApp({ echoDelayMs: 40 });
    try {
      const created = await app.api("POST", "/sessions", { repo: app.repo, baseBranch: "main", agent: "echo" });
      const id = created.body.id as string;
      const pending = app.api("GET", `/sessions/${id}/events?after=0&waitMs=2000`, undefined, {
        Accept: "application/json",
      });
      await app.api("POST", `/sessions/${id}/prompts`, { text: "polled", mode: "queue" });
      const page = await pending;
      assert.equal(page.status, 200);
      assert.ok(page.body.events.length > 0);
      assert.equal(page.body.cursor, page.body.events.at(-1).id);
      await waitFor(async () => (await app.api("GET", `/sessions/${id}`)).body.state === "idle");
      const caughtUp = await app.api("GET", `/sessions/${id}/events?after=0`, undefined, { Accept: "application/json" });
      const empty = await app.api(
        "GET",
        `/sessions/${id}/events?after=${caughtUp.body.cursor}&waitMs=40`,
        undefined,
        { Accept: "application/json" },
      );
      assert.equal(empty.body.events.length, 0);
      assert.equal(empty.body.cursor, caughtUp.body.cursor);
    } finally {
      await app.stop();
    }
  });
});
