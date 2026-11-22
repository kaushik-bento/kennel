import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { KennelError } from "./errors.js";

const execFileAsync = promisify(execFile);

export async function runCommand(
  command: string,
  args: string[],
  options?: { cwd?: string; status?: number },
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: options?.cwd,
      maxBuffer: 20 * 1024 * 1024,
      env: process.env,
    });
    return stdout.toString();
  } catch (err) {
    const failure = err as { stderr?: unknown; message?: string };
    const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
    const detail = (stderr || failure.message || "command failed").slice(0, 2000);
    throw new KennelError(options?.status ?? 500, `${command} ${args.join(" ")} failed: ${detail}`);
  }
}
