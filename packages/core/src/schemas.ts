import { z } from "zod";
import {
  AGENT_KINDS,
  APPROVAL_POLICIES,
  PERMISSION_MODES,
  SANDBOX_MODES,
} from "./types.js";

export const permissionsSchema = z
  .object({
    permissionMode: z.enum(PERMISSION_MODES).optional(),
    allowedTools: z.array(z.string()).optional(),
    disallowedTools: z.array(z.string()).optional(),
    sandbox: z.enum(SANDBOX_MODES).optional(),
    approvalPolicy: z.enum(APPROVAL_POLICIES).optional(),
    networkAccess: z.boolean().optional(),
  })
  .strict();

export const createSessionSchema = z
  .object({
    repo: z.string().min(1),
    baseBranch: z.string().min(1),
    agent: z.enum(AGENT_KINDS),
    permissions: permissionsSchema.optional(),
    model: z.string().min(1).optional(),
  })
  .strict();

export const sendPromptSchema = z
  .object({
    text: z.string().min(1),
    mode: z.enum(["queue", "steer"]),
  })
  .strict();

export const finishSchema = z
  .object({
    commitMessage: z.string().min(1),
    openPr: z.boolean().optional(),
  })
  .strict();

export const getEventsSchema = z
  .object({
    sessionId: z.string().min(1),
    after: z.number().int().nonnegative().optional(),
    waitMs: z.number().int().nonnegative().max(60_000).optional(),
  })
  .strict();
