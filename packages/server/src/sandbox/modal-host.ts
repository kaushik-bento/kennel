import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import type { KennelConfig } from "../config.js";
import type { ModalHost, ModalOpenSpec, RunnerStdio } from "./types.js";

/**
 * Real Modal client. Imported only when `KENNEL_BACKEND=modal`, so the local
 * backend and the tests do not need Modal credentials.
 *
 * Agent credentials are a Modal Secret referenced by name. Modal injects the
 * values into the sandbox. This process never reads or logs them.
 */
export async function connectModalHost(config: KennelConfig): Promise<ModalHost> {
  const { ModalClient } = await import("modal");
  const modal = new ModalClient();
  const environment = config.modalEnvironment;
  const envParams = environment ? { environment } : {};
  const app = await modal.apps.fromName(config.modalApp, { createIfMissing: true, ...envParams });
  const image = await modal.images.fromName(config.modalImage, envParams);
  const secret = await modal.secrets.fromName(config.modalSecret, envParams);
  console.log(
    `[kennel] modal app=${config.modalApp} image=${config.modalImage} secret=${config.modalSecret}` +
      (environment ? ` environment=${environment}` : ""),
  );

  return {
    async open(spec: ModalOpenSpec): Promise<RunnerStdio> {
      const volume = await modal.volumes.fromName(spec.volumeName, { createIfMissing: true, ...envParams });
      let sandboxImage = image;
      if (spec.imageName && spec.imageName !== config.modalImage) {
        try {
          sandboxImage = await modal.images.fromName(spec.imageName, envParams);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[kennel] env image ${spec.imageName} unavailable (${message}); using ${config.modalImage}`);
        }
      }
      const name = `kennel-${spec.sessionId}`;
      try {
        const existing = await modal.sandboxes.fromName(config.modalApp, name, envParams);
        await terminateAndWait(existing);
      } catch {
        // No running sandbox with this name.
      }
      const createParams = {
        name,
        volumes: { "/var/kennel": volume },
        secrets: [secret],
        timeoutMs: config.modalSandboxTimeoutMs,
        idleTimeoutMs: config.modalSandboxTimeoutMs,
        workdir: "/var/kennel",
        env: { HOME: "/var/kennel/home", IS_SANDBOX: "1" },
        ...(spec.cpu ? { cpu: spec.cpu } : {}),
        ...(spec.memoryMiB ? { memoryMiB: spec.memoryMiB, memoryLimitMiB: spec.memoryMiB } : {}),
      };
      // Sandbox names are released asynchronously after terminate, so a
      // prompt that arrives right after the previous release can still see
      // "already in use". Retry for a short while instead of failing the session.
      let sandbox: Awaited<ReturnType<typeof modal.sandboxes.create>> | undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          sandbox = await modal.sandboxes.create(app, sandboxImage, createParams);
          break;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!/already in use/i.test(message) || attempt >= NAME_RETRY_ATTEMPTS) throw err;
          await sleep(NAME_RETRY_DELAY_MS);
        }
      }
      console.log(`[kennel] modal sandbox ${sandbox.sandboxId} volume ${spec.volumeName}`);
      const proc = await sandbox.exec(["node", "/opt/kennel/packages/server/dist/runner.js"], {
        stdout: "pipe",
        stderr: "pipe",
        mode: "text",
        workdir: "/opt/kennel",
        env: { HOME: "/var/kennel/home", IS_SANDBOX: "1" },
      });
      const stderr = createInterface({ input: Readable.from(proc.stderr) });
      stderr.on("line", (line) => {
        if (line.trim()) console.error(`[kennel-runner ${spec.sessionId}] ${line}`);
      });
      return {
        sandboxId: sandbox.sandboxId,
        write: (frame) => proc.stdin.writeText(frame),
        lines() {
          return readLines(proc.stdout);
        },
        close: async () => {
          stderr.close();
          await terminateAndWait(sandbox);
        },
      };
    },
    async deleteVolume(volumeName: string) {
      await modal.volumes.delete(volumeName, { allowMissing: true, ...envParams });
    },
    async imageExists(name: string) {
      try {
        await modal.images.fromName(name, envParams);
        return true;
      } catch {
        return false;
      }
    },
  };
}

const NAME_RETRY_ATTEMPTS = 30;
const NAME_RETRY_DELAY_MS = 1000;
const TERMINATE_WAIT_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Terminate and wait (bounded) for the sandbox to exit so its name frees up. */
async function terminateAndWait(sandbox: { terminate(params: { wait: true }): Promise<number> }): Promise<void> {
  await Promise.race([sandbox.terminate({ wait: true }).catch(() => undefined), sleep(TERMINATE_WAIT_MS)]);
}

async function* readLines(stream: AsyncIterable<string>): AsyncGenerator<string> {
  const lines = createInterface({ input: Readable.from(stream) });
  for await (const line of lines) yield line;
}
