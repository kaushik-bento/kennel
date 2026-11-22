export const CHECK_TIERS = ["fast", "targeted", "full"] as const;
export type CheckTier = (typeof CHECK_TIERS)[number];

export interface CheckSpec {
  command: string;
  cpu?: number;
  memoryMiB?: number;
}

export interface RuntimeSpec {
  name: "node" | "bun" | "python" | "uv" | "pnpm";
  version?: string;
}

export interface ServiceSpec {
  kind: "postgres" | "redis";
  version: string;
  extensions?: string[];
  databases?: string[];
  port?: number;
  user?: string;
  password?: string;
}

export interface SandboxSize {
  cpu?: number;
  memoryMiB?: number;
}

/** One repo's test environment. Matched by repository URL. */
export interface EnvProfile {
  name: string;
  description?: string;
  repos: string[];
  apt: string[];
  preBuild: string[];
  runtimes: RuntimeSpec[];
  services: ServiceSpec[];
  /** Commands baked into the image after the repo is cloned. Migrations and seeds belong here. */
  setup: string[];
  env: Record<string, string>;
  checks: Partial<Record<CheckTier, CheckSpec>>;
  /** Directories that live on the session volume so installs and builds stay warm. */
  cache: string[];
  /** Lockfiles hashed at the default branch. A new hash publishes a new image. */
  lockfiles: string[];
  /** Shown to the agent as things it must not do. */
  deny: string[];
  /** Removed from the agent environment. */
  stripEnv: string[];
  /** Deleted from the sandbox home before the agent starts. */
  stripPaths: string[];
  notes: string[];
  /** Sandbox size for the session. Defaults to the larger of the fast and targeted tiers. */
  sandbox?: SandboxSize;
}

export interface LockfileSnapshot {
  path: string;
  /** Null when the file is not in the tree. */
  content: string | null;
}

export interface ImageDecision {
  image: string;
  fallback: boolean;
  /** Image that should exist for this lockfile hash. Set when a profile matched. */
  desired?: string;
  hash?: string;
  profile: EnvProfile | null;
  reason?: string;
}

export interface CheckRecord {
  tier: string;
  command?: string;
  exitCode?: number | null;
  summary?: string;
}

export interface CheckObservation {
  tier: CheckTier;
  command: string;
  seen: boolean;
  exitCode: number | null;
  isError: boolean;
}
