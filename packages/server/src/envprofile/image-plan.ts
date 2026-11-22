import type { EnvProfile, ServiceSpec } from "./types.js";

export interface ImageBuildPlan {
  /** Dockerfile instructions after the kennel-agent base. */
  commands: string[];
  /** Shell run inside the image after the repo is cloned. */
  setupScript: string;
  /** Shell script the runner executes at the start of every sandbox. */
  sessionScript: string;
}

/**
 * Turn a profile into image layers. The repo is cloned during the build so
 * dependency installs, migrations, and seeds are baked in, then the local
 * database directory is snapshotted. Secrets stay in the build environment
 * (`GITHUB_TOKEN`) and are not written into these command strings.
 */
export function planImage(profile: EnvProfile): ImageBuildPlan {
  const commands: string[] = [];
  for (const line of profile.preBuild) commands.push(`RUN ${line}`);
  if (profile.apt.length > 0) {
    const packages = profile.apt.map(shellArg).join(" ");
    commands.push(
      `RUN apt-get update && apt-get install -y --no-install-recommends ${packages} && rm -rf /var/lib/apt/lists/*`,
    );
  }
  for (const runtime of profile.runtimes) commands.push(...runtimeCommands(runtime.name, runtime.version));
  commands.push("RUN mkdir -p /opt/kennel-env/src");
  commands.push(runBash(cloneScript()));
  const postgres = profile.services.find((service) => service.kind === "postgres");
  const setup = setupScript(profile, postgres);
  commands.push(runBash(setup));
  return { commands, setupScript: setup, sessionScript: renderSessionScript(profile, postgres) };
}

function runBash(body: string): string {
  return `RUN echo ${Buffer.from(body, "utf8").toString("base64")} | base64 -d | bash`;
}

function cloneScript(): string {
  return [
    "set -euo pipefail",
    'if [ -n "${GITHUB_TOKEN:-}" ]; then',
    '  git -c http.extraheader="AUTHORIZATION: bearer ${GITHUB_TOKEN}" clone --depth 1 "$REPO_URL" /opt/kennel-env/src',
    "else",
    '  git clone --depth 1 "$REPO_URL" /opt/kennel-env/src',
    "fi",
    'git -C /opt/kennel-env/src fetch --depth 1 origin "$GIT_SHA"',
    'git -C /opt/kennel-env/src checkout --detach "$GIT_SHA"',
  ].join("\n");
}

function setupScript(profile: EnvProfile, postgres: ServiceSpec | undefined): string {
  const lines = ["set -euo pipefail", "cd /opt/kennel-env/src"];
  if (postgres) lines.push(...startPostgres(postgres), ...prepareDatabases(postgres));
  for (const [key, value] of Object.entries(profile.env)) {
    lines.push(`export ${key}=${shellArg(value)}`);
  }
  for (const command of profile.setup) lines.push(command);
  if (postgres) {
    const version = postgres.version;
    lines.push(
      `pg_ctlcluster ${shellArg(version)} main stop`,
      "mkdir -p /opt/kennel-env/pg-snapshot",
      `cp -a /var/lib/postgresql/${version}/main/. /opt/kennel-env/pg-snapshot/`,
    );
  }
  return lines.join("\n");
}

function startPostgres(service: ServiceSpec): string[] {
  const user = quoteIdent(service.user ?? "postgres");
  const password = sqlString(service.password ?? "postgres");
  return [
    `pg_ctlcluster ${service.version} main start`,
    `su - postgres -c "psql -v ON_ERROR_STOP=1 -c \\"ALTER USER ${user} PASSWORD ${password}\\""`,
  ];
}

function prepareDatabases(service: ServiceSpec): string[] {
  const lines: string[] = [];
  for (const database of service.databases ?? []) {
    const ident = quoteIdent(database);
    lines.push(
      `su - postgres -c "psql -tAc \\"SELECT 1 FROM pg_database WHERE datname = ${sqlString(database)}\\" | grep -q 1 || createdb ${ident}"`,
    );
    for (const extension of service.extensions ?? []) {
      lines.push(
        `su - postgres -c "psql -d ${ident} -v ON_ERROR_STOP=1 -c \\"CREATE EXTENSION IF NOT EXISTS ${quoteIdent(extension)}\\""`,
      );
    }
  }
  return lines;
}

export function renderSessionScript(profile: EnvProfile, postgres?: ServiceSpec): string {
  const pg = postgres ?? profile.services.find((service) => service.kind === "postgres");
  const redis = profile.services.find((service) => service.kind === "redis");
  const lines = ["#!/bin/bash", "set -euo pipefail"];
  for (const dir of profile.cache) {
    if (dir.startsWith("/")) lines.push(`mkdir -p ${shellArg(dir)}`);
  }
  lines.push("mkdir -p /var/kennel/home");
  if (pg) {
    const version = pg.version;
    lines.push(
      "if [ ! -d /opt/kennel-env/pg-snapshot ]; then",
      '  echo "[kennel] database snapshot is not in this image; local database was not restored" >&2',
      "else",
      "  if [ ! -f /var/kennel/pgdata/PG_VERSION ]; then",
      "    mkdir -p /var/kennel/pgdata",
      "    cp -a /opt/kennel-env/pg-snapshot/. /var/kennel/pgdata/",
      "    chown -R postgres:postgres /var/kennel/pgdata",
      "  fi",
      `  sed -i "s|^data_directory = .*|data_directory = '/var/kennel/pgdata'|" /etc/postgresql/${version}/main/postgresql.conf`,
      `  pg_ctlcluster ${shellArg(version)} main start`,
      "fi",
    );
  }
  if (redis) {
    const port = redis.port ?? 6379;
    lines.push(
      "mkdir -p /var/kennel/redis",
      `redis-server --daemonize yes --bind 127.0.0.1 --port ${port} --dir /var/kennel/redis`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function runtimeCommands(name: EnvProfile["runtimes"][number]["name"], version: string | undefined): string[] {
  if (name === "node") {
    const major = (version ?? "22").split(".")[0] ?? "22";
    return [
      `RUN curl -fsSL https://deb.nodesource.com/setup_${major}.x | bash - && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*`,
    ];
  }
  if (name === "bun") {
    const pin = version ? `export BUN_VERSION=${shellArg(version)}; ` : "";
    return [
      `RUN ${pin}curl -fsSL https://bun.sh/install | bash && ln -sf /root/.bun/bin/bun /usr/local/bin/bun`,
    ];
  }
  if (name === "uv") {
    return ["RUN curl -LsSf https://astral.sh/uv/install.sh | sh && ln -sf /root/.local/bin/uv /usr/local/bin/uv"];
  }
  if (name === "python") {
    const pin = version ? shellArg(version) : "";
    return [`RUN uv python install ${pin}`.trim()];
  }
  const pin = version ? shellArg(version) : "latest";
  return [`RUN npm install -g pnpm@${pin} && ln -sf "$(command -v pnpm)" /usr/local/bin/pnpm`];
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quoteIdent(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`unsafe SQL identifier: ${value}`);
  return value;
}
