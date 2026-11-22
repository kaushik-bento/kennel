# Agent image for kennel sessions. The control plane does not run this image.
# Modal's JS SDK builds it with `npx tsx deploy/modal/build-image.ts`, which
# sends these instructions (everything after FROM) as dockerfileCommands.
# The published name defaults to kennel-agent (KENNEL_MODAL_IMAGE). The script
# substitutes @@KENNEL_REPO_URL@@ and @@KENNEL_GIT_SHA@@ (KENNEL_GIT_REF, default main).
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl gnupg ripgrep && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /usr/share/keyrings && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
RUN curl -fsSL https://claude.ai/install.sh | bash
RUN curl -fsSL https://chatgpt.com/codex/install.sh | sh
RUN git init -q /opt/kennel && cd /opt/kennel && git fetch -q --depth 1 @@KENNEL_REPO_URL@@ @@KENNEL_GIT_SHA@@ && git checkout -q FETCH_HEAD && npm ci && npm run build
WORKDIR /opt/kennel
