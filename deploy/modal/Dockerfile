# Agent image for kennel sessions. The control plane does not run this image.
# Modal's JS SDK builds it with `npx tsx deploy/modal/build-image.ts`, which
# sends these instructions (everything after FROM) as dockerfileCommands.
# The published name defaults to kennel-agent (KENNEL_MODAL_IMAGE).
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl gnupg && rm -rf /var/lib/apt/lists/*
RUN mkdir -p /usr/share/keyrings && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*
ENV PATH="/root/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
RUN curl -fsSL https://claude.ai/install.sh | bash
RUN curl -fsSL https://chatgpt.com/codex/install.sh | sh
RUN git clone --depth 1 https://github.com/kaushik-bento/kennel.git /opt/kennel && cd /opt/kennel && npm ci && npm run build
WORKDIR /opt/kennel
