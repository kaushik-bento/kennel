/**
 * Serializes session mutations. Agent I/O may be awaited inside a task;
 * agent callbacks must only enqueue more tasks, never wait for them.
 */
export class Actor {
  private queue: Array<() => Promise<void>> = [];
  private draining = false;

  run<T>(task: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          resolve(await task());
        } catch (err) {
          reject(err);
        }
      });
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift();
        if (task) await task();
      }
    } finally {
      this.draining = false;
      if (this.queue.length > 0) void this.drain();
    }
  }
}
