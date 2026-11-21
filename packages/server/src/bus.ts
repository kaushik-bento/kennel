import { EventEmitter } from "node:events";
import type { KennelEvent } from "@kennel/core";

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: KennelEvent): void {
    this.emitter.emit("event", event);
  }

  wait(sessionId: string, after: number, waitMs: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || waitMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const onEvent = (event: KennelEvent) => {
        if (event.sessionId === sessionId && event.id > after) finish();
      };
      const finish = () => {
        clearTimeout(timer);
        this.emitter.off("event", onEvent);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, waitMs);
      signal?.addEventListener("abort", finish, { once: true });
      this.emitter.on("event", onEvent);
    });
  }
}
