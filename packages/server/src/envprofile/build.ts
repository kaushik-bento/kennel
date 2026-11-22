import type { EnvProfile } from "./types.js";
import { planImage } from "./image-plan.js";

export interface PublishImageInput {
  profile: EnvProfile;
  repoUrl: string;
  gitSha: string;
  imageName: string;
  appName: string;
  secretName: string;
  baseImage: string;
  environment?: string;
}

/** Build and publish one profile image. Requires Modal credentials in the environment. */
export async function publishEnvironmentImage(input: PublishImageInput): Promise<void> {
  const { ModalClient } = await import("modal");
  const modal = new ModalClient();
  const envParams = input.environment ? { environment: input.environment } : {};
  const app = await modal.apps.fromName(input.appName, { createIfMissing: true, ...envParams });
  const base = await modal.images.fromName(input.baseImage, envParams);
  const secret = await modal.secrets.fromName(input.secretName, envParams);
  const plan = planImage(input.profile);
  const image = base.dockerfileCommands(plan.commands, {
    secrets: [secret],
    env: { REPO_URL: input.repoUrl, GIT_SHA: input.gitSha },
  });
  console.log(`[kennel] building ${input.imageName} from ${input.baseImage} (${plan.commands.length} steps, ${input.gitSha})`);
  await image.build(app);
  await image.publish(input.imageName, envParams);
  console.log(`[kennel] published image ${input.imageName}`);
}
