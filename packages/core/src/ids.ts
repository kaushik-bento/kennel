import { randomBytes } from "node:crypto";

export function createId(): string {
  return randomBytes(8).toString("hex");
}

export function branchName(sessionId: string): string {
  return `kennel/${sessionId}`;
}
