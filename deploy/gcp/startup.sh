#!/bin/bash
# Control plane only. Ubuntu 24.04.
# Agent processes run in Modal sandboxes (KENNEL_BACKEND=modal). This VM does
# not install Claude Code or Codex and does not hold their credentials.
# Agent tokens live in a Modal Secret named by KENNEL_MODAL_SECRET.
#
# Required Secret Manager secrets in this project:
#   kennel-token          KENNEL_TOKEN
#   modal-token           JSON {"token_id": "...", "token_secret": "..."}
#                         (or separate modal-token-id / modal-token-secret)
# Optional:
#   kennel-public-url     KENNEL_PUBLIC_URL (used only in the startup connector line)
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl xz-utils git jq

if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  NODE_VERSION=22.21.0
  ARCH=$(dpkg --print-architecture)
  case "$ARCH" in
    amd64) NODE_ARCH=x64 ;;
    arm64) NODE_ARCH=arm64 ;;
    *) echo "unsupported architecture: $ARCH" >&2; exit 1 ;;
  esac
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1
fi

id kennel >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin kennel
install -d -o kennel -g kennel /var/lib/kennel /opt/kennel

if [[ ! -f /opt/kennel/package.json ]]; then
  CLONE_ARGS=(--depth 1)
  if [[ -n "${KENNEL_GIT_REF:-}" ]]; then
    CLONE_ARGS+=(--branch "$KENNEL_GIT_REF")
  fi
  sudo -u kennel git clone "${CLONE_ARGS[@]}" "${KENNEL_REPO_URL:-https://github.com/kaushik-bento/kennel.git}" /opt/kennel
fi
sudo -u kennel bash -lc 'cd /opt/kennel && npm ci && npm run build'

metadata() {
  curl -sf -H "Metadata-Flavor: Google" "http://metadata.google.internal/computeMetadata/v1/$1"
}

fetch_secret() {
  local name="$1"
  local token project payload
  token=$(metadata "instance/service-accounts/default/token" | jq -r .access_token)
  project=$(metadata "project/project-id")
  payload=$(curl -sf -H "Authorization: Bearer ${token}" \
    "https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${name}/versions/latest:access" \
    | jq -r .payload.data)
  if [[ -z "$payload" || "$payload" == "null" ]]; then
    return 1
  fi
  printf '%s' "$payload" | base64 -d
}

# systemd EnvironmentFile does not use shell quoting. Strip newlines and write KEY=value.
write_env() {
  local key="$1"
  local value="${2//$'\n'/}"
  printf '%s=%s\n' "$key" "$value"
}

umask 077
install -d -o root -g kennel -m 750 /etc/kennel
{
  write_env KENNEL_TOKEN "$(fetch_secret kennel-token)"
  if modal_json=$(fetch_secret modal-token 2>/dev/null); then
    write_env MODAL_TOKEN_ID "$(jq -r .token_id <<<"$modal_json")"
    write_env MODAL_TOKEN_SECRET "$(jq -r .token_secret <<<"$modal_json")"
  else
    write_env MODAL_TOKEN_ID "$(fetch_secret modal-token-id)"
    write_env MODAL_TOKEN_SECRET "$(fetch_secret modal-token-secret)"
  fi
  write_env KENNEL_BACKEND modal
  write_env KENNEL_HOST 127.0.0.1
  write_env KENNEL_PORT 8787
  write_env KENNEL_DATA_DIR /var/lib/kennel
  write_env KENNEL_MODAL_APP "${KENNEL_MODAL_APP:-kennel}"
  write_env KENNEL_MODAL_IMAGE "${KENNEL_MODAL_IMAGE:-kennel-agent}"
  write_env KENNEL_MODAL_SECRET "${KENNEL_MODAL_SECRET:-kennel-agent}"
  # Eval keys live in their own Modal Secrets, attached by name next to kennel-agent.
  write_env KENNEL_MODAL_EXTRA_SECRETS "${KENNEL_MODAL_EXTRA_SECRETS:-openai-eval-key,fish-audio-api-key}"
  write_env KENNEL_SANDBOX_IDLE_MS "${KENNEL_SANDBOX_IDLE_MS:-1800000}"
  write_env KENNEL_SANDBOX_BUSY_MAX_MS "${KENNEL_SANDBOX_BUSY_MAX_MS:-10800000}"
  if url=$(fetch_secret kennel-public-url 2>/dev/null); then
    write_env KENNEL_PUBLIC_URL "$url"
  fi
} > /etc/kennel/kennel.env
chown root:kennel /etc/kennel/kennel.env
chmod 640 /etc/kennel/kennel.env

NODE_BIN=$(command -v node)
cat > /etc/systemd/system/kennel.service <<UNIT
[Unit]
Description=kennel control plane
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=kennel
Group=kennel
EnvironmentFile=/etc/kennel/kennel.env
WorkingDirectory=/opt/kennel
ExecStart=${NODE_BIN} --disable-warning=ExperimentalWarning /opt/kennel/packages/server/dist/index.js
Restart=on-failure
RestartSec=2
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now kennel.service
echo "kennel control plane started. Agent credentials stay in Modal Secret ${KENNEL_MODAL_SECRET:-kennel-agent}."
