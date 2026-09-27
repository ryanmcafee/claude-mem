# syntax=docker/dockerfile:1
# Keep the native build toolchain out of the runtime image. Update the Node
# builder/runtime digests together and keep Bun aligned with plugin/bun.lock.
FROM oven/bun:1.3.12@sha256:8956c7667fa17beb6e3c664115e66bdacfe502da5d99603626e74c197bdef160 AS bun
FROM node:22-bookworm@sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7 AS dependencies
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /opt/claude-mem
COPY plugin/package.json plugin/bun.lock ./
RUN bun install --frozen-lockfile --production
# This executable is used by the bundled agent SDK; never resolve "latest".
ARG CLAUDE_CODE_VERSION=2.1.283
RUN npm install --prefix /opt/claude-cli --omit=dev --no-audit --no-fund \
    @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

FROM node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS runtime
# curl provides the compose healthcheck; git is a Claude runtime dependency.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git \
 && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /opt/yarn* \
 && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=dependencies /opt/claude-cli /opt/claude-cli
RUN ln -s /opt/claude-cli/node_modules/.bin/claude /usr/local/bin/claude
COPY plugin/ /opt/claude-mem/
COPY --from=dependencies /opt/claude-mem/node_modules /opt/claude-mem/node_modules
COPY --chmod=755 docker/claude-mem/entrypoint.sh /usr/local/bin/claude-mem-entrypoint
# Home is intentionally immutable; only these subdirectories need volumes.
RUN mkdir -p /home/node/.claude /home/node/.claude-mem /data/claude-mem \
 && chown node:node /home/node/.claude /home/node/.claude-mem /data/claude-mem
ENV CLAUDE_MEM_CONTAINER_MODE=server \
    CLAUDE_MEM_RUNTIME=server-beta \
    CLAUDE_MEM_DATA_DIR=/data/claude-mem \
    XDG_CACHE_HOME=/tmp/.cache \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_AUTOUPDATER=1
USER 1000:1000
WORKDIR /home/node
EXPOSE 37877
ENTRYPOINT ["/usr/local/bin/claude-mem-entrypoint"]
CMD []
