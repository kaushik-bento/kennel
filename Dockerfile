FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN npm ci && npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV KENNEL_HOST=127.0.0.1
ENV KENNEL_PORT=8787
ENV KENNEL_DATA_DIR=/var/lib/kennel
ENV KENNEL_BACKEND=local
EXPOSE 8787

RUN mkdir -p /var/lib/kennel && chown node:node /var/lib/kennel
USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "packages/server/dist/index.js"]
