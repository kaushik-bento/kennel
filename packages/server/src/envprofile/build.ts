import type { EnvProfile } from "./types.js";
import { planImage } from "./image-plan.js";
import { buildFailureMessage, redactSecrets } from "./redact.js";

export interface PublishImageInput {
  profile: EnvProfile;
  repoUrl: string;
  gitSha: string;
  imageName: string;
  appName: string;
  baseImage: string;
  /** Modal secret that contains only a GitHub token. The agent secret is not mounted. */
  buildSecret?: string;
  environment?: string;
  /** Process environment used to find a GitHub token and to redact logs. */
  env?: NodeJS.ProcessEnv;
}

interface JoinItem {
  result?: { status?: number; exception?: string };
  taskLogs?: Array<{ data?: string }>;
  entryId?: string;
  eof?: boolean;
}

const STATUS_SUCCESS = 1;
const STATUS_FAILURE = 2;
const STATUS_TERMINATED = 3;
const STATUS_TIMEOUT = 4;
const STATUS_EVICTED = 8;

/**
 * Build and publish one profile image.
 * The build receives REPO_URL, GIT_SHA, and at most a GitHub token.
 * Agent credentials are not mounted. Build logs are streamed and redacted.
 */
export async function publishEnvironmentImage(input: PublishImageInput): Promise<void> {
  const { ModalClient } = await import("modal");
  const env = input.env ?? process.env;
  const modal = new ModalClient();
  const envParams = input.environment ? { environment: input.environment } : {};
  const app = await modal.apps.fromName(input.appName, { createIfMissing: true, ...envParams });
  const base = await modal.images.fromName(input.baseImage, envParams);
  const plan = planImage(input.profile);
  const secretIds = await buildSecretIds(modal, input, env, envParams);
  const builderVersion = await modal.getImageBuilderVersion(input.environment);
  const cp = modal.cpClient as unknown as {
    imageGetOrCreate(req: Record<string, unknown>): Promise<{ imageId: string; result?: { status?: number; exception?: string } }>;
    imageJoinStreaming(req: Record<string, unknown>): AsyncIterable<JoinItem>;
  };
  console.log(`[kennel] building ${input.imageName} from ${input.baseImage} (${plan.commands.length} steps, ${input.gitSha})`);
  let response: { imageId: string; result?: { status?: number; exception?: string } };
  try {
    response = await cp.imageGetOrCreate({
      appId: app.appId,
      image: {
        dockerfileCommands: ["FROM base", ...plan.commands],
        baseImages: [{ dockerTag: "base", imageId: base.imageId }],
        secretIds,
        contextFiles: [],
      },
      builderVersion,
      forceBuild: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(redactSecrets(message, env));
  }
  const result = await waitForBuild(cp, response, env);
  if (result.status !== STATUS_SUCCESS) {
    throw new Error(failureText(response.imageId, result, env));
  }
  const built = await modal.images.fromId(response.imageId);
  await built.publish(input.imageName, envParams);
  console.log(`[kennel] published image ${input.imageName} (${response.imageId})`);
}

async function buildSecretIds(
  modal: {
    secrets: {
      fromObject(entries: Record<string, string>, params?: { environment?: string }): Promise<{ secretId: string; _hydrate(client: unknown): Promise<void> }>;
      fromName(name: string, params?: { environment?: string }): Promise<{ secretId: string; _hydrate(client: unknown): Promise<void> }>;
    };
  },
  input: PublishImageInput,
  env: NodeJS.ProcessEnv,
  envParams: { environment?: string },
): Promise<string[]> {
  const entries: Record<string, string> = { REPO_URL: input.repoUrl, GIT_SHA: input.gitSha };
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (token) entries.GITHUB_TOKEN = token;
  const created = await modal.secrets.fromObject(entries, envParams);
  await created._hydrate(modal);
  const ids = created.secretId ? [created.secretId] : [];
  if (!token && input.buildSecret) {
    const named = await modal.secrets.fromName(input.buildSecret, envParams);
    await named._hydrate(modal);
    if (named.secretId) ids.push(named.secretId);
    console.log(`[kennel] image build GitHub token: Modal secret ${input.buildSecret}`);
  } else if (token) {
    console.log("[kennel] image build GitHub token: process environment only");
  } else {
    console.error("[kennel] image build has no GitHub token. Set GITHUB_TOKEN or KENNEL_BUILD_SECRET.");
  }
  return ids;
}

async function waitForBuild(
  cp: { imageJoinStreaming(req: Record<string, unknown>): AsyncIterable<JoinItem> },
  response: { imageId: string; result?: { status?: number; exception?: string } },
  env: NodeJS.ProcessEnv,
): Promise<{ status?: number; exception?: string }> {
  if (response.result?.status) return response.result;
  let lastEntryId = "";
  let joined: { status?: number; exception?: string } | undefined;
  while (!joined) {
    let sawItem = false;
    for await (const item of cp.imageJoinStreaming({
      imageId: response.imageId,
      timeout: 55,
      lastEntryId,
      includeLogsForFinished: true,
    })) {
      sawItem = true;
      if (item.entryId) lastEntryId = item.entryId;
      for (const log of item.taskLogs ?? []) {
        if (log.data) process.stdout.write(redactSecrets(log.data, env));
      }
      if (item.result?.status) {
        joined = item.result;
        break;
      }
      if (item.eof) break;
    }
    if (!sawItem && !joined) break;
  }
  return joined ?? { status: 0, exception: "" };
}

function failureText(imageId: string, result: { status?: number; exception?: string }, env: NodeJS.ProcessEnv): string {
  const exception = redactSecrets(result.exception ?? "", env);
  if (result.status === STATUS_TERMINATED) {
    return `${buildFailureMessage(imageId, exception)}\nThe build was shut down. Try again.`;
  }
  if (result.status === STATUS_TIMEOUT) {
    return `${buildFailureMessage(imageId, exception)}\nThe build timed out.`;
  }
  if (result.status === STATUS_FAILURE || result.status === STATUS_EVICTED || result.status !== STATUS_SUCCESS) {
    return buildFailureMessage(imageId, exception);
  }
  return buildFailureMessage(imageId, exception);
}
