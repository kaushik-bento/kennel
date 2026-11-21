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
      const name = `kennel-${spec.sessionId}`;
      try {
        const existing = await modal.sandboxes.fromName(config.modalApp, name, envParams);
        await existing.terminate();
      } catch {
        // No running sandbox with this name.
      }
      const sandbox = await modal.sandboxes.create(app, image, {
        name,
        volumes: { "/var/kennel": volume },
        secrets: [secret],
        timeoutMs: config.modalSandboxTimeoutMs,
        idleTimeoutMs: config.modalSandboxTimeoutMs,
        workdir: "/var/kennel",
        env: { HOME: "/var/kennel/home" },
      });
      console.log(`[kennel] modal sandbox ${sandbox.sandboxId} volume ${spec.volumeName}`);
      const proc = await sandbox.exec(["node", "/opt/kennel/packages/server/dist/runner.js"], {
        stdout: "pipe",
        stderr: "pipe",
        mode: "text",
        workdir: "/opt/kennel",
        env: { HOME: "/var/kennel/home" },
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
          await sandbox.terminate().catch(() => undefined);
        },
      };
    },
    async deleteVolume(volumeName: string) {
      await modal.volumes.delete(volumeName, { allowMissing: true, ...envParams });
    },
  };
}

async function* readLines(stream: AsyncIterable<string>): AsyncGenerator<string> {
  const lines = createInterface({ input: Readable.from(stream) });
  for await (const line of lines) yield line;
}
