import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface ProcInfo {
  pid: number;
  ppid: number;
  state: string;
  /** Start time in clock ticks since boot (field 22 of /proc/<pid>/stat). */
  start: number;
  command: string;
}

/** Linux USER_HZ. The kernel reports /proc start times in these ticks. */
const TICKS_PER_SECOND = 100;
/**
 * Children the agent CLI starts with itself (MCP servers, language servers)
 * live as long as it does. Only processes started this long after the CLI
 * count as work the agent kicked off.
 */
const STARTUP_GRACE_SECONDS = 3;
/** Long-lived helpers the CLI may start later (MCP servers). Never counted as work. */
const HELPER = /(^|[\s/@-])mcp([\s/@-]|-server|$)|modelcontextprotocol/i;

export function readProcs(procDir = "/proc"): ProcInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(procDir);
  } catch {
    return [];
  }
  const procs: ProcInfo[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(path.join(procDir, entry, "stat"), "utf8");
      // comm is in parentheses and may contain spaces; parse after the last ')'.
      const close = stat.lastIndexOf(")");
      const rest = stat.slice(close + 2).split(" ");
      const state = rest[0] ?? "?";
      const ppid = Number(rest[1]);
      const start = Number(rest[19]);
      let command = stat.slice(stat.indexOf("(") + 1, close);
      try {
        const cmdline = readFileSync(path.join(procDir, entry, "cmdline"), "utf8").split("\0").filter(Boolean).join(" ");
        if (cmdline) command = cmdline;
      } catch {
        // Keep comm.
      }
      procs.push({ pid: Number(entry), ppid, state, start, command: command.slice(0, 160) });
    } catch {
      // The process exited while we were reading.
    }
  }
  return procs;
}

/**
 * Processes the agent started that are still running: descendants of the
 * agent CLI (a direct child of the runner) that are not zombies and were
 * started after the CLI's own startup grace period. Background shells, bun
 * install, tsc, and test runs show up here; the CLI itself does not.
 */
export function busyProcesses(runnerPid: number, procs: ProcInfo[]): ProcInfo[] {
  const children = new Map<number, ProcInfo[]>();
  for (const proc of procs) {
    const list = children.get(proc.ppid) ?? [];
    list.push(proc);
    children.set(proc.ppid, list);
  }
  const busy: ProcInfo[] = [];
  for (const agent of children.get(runnerPid) ?? []) {
    const threshold = agent.start + STARTUP_GRACE_SECONDS * TICKS_PER_SECOND;
    const stack = [...(children.get(agent.pid) ?? [])];
    while (stack.length > 0) {
      const proc = stack.pop() as ProcInfo;
      stack.push(...(children.get(proc.pid) ?? []));
      if (proc.state === "Z" || proc.state === "X") continue;
      if (proc.start < threshold) continue;
      if (HELPER.test(proc.command)) continue;
      busy.push(proc);
    }
  }
  return busy;
}
