# syntax=docker/dockerfile:1
# Builder and runtime use the same supported Alpine release/libc on each platform.
FROM oven/bun:1.3.12-alpine@sha256:26d8996560ca94eab9ce48afc0c7443825553c9a851f40ae574d47d20906826d AS bun
FROM alpine:3.24.2@sha256:294b683cb724975bec92580e1e685676bd4b50bda910ddb8c51d4cabeaec77e6 AS base
RUN printf '%s\n' https://dl-cdn.alpinelinux.org/alpine/v3.24/main https://dl-cdn.alpinelinux.org/alpine/v3.24/community > /etc/apk/repositories \
 && apk upgrade --no-cache \
 && apk add --no-cache nodejs ca-certificates curl git bash coreutils libgcc libstdc++ ripgrep \
 && addgroup -g 1000 node && adduser -D -u 1000 -G node node
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ENV USE_BUILTIN_RIPGREP=0
FROM base AS dependencies
RUN apk add --no-cache npm python3 make g++ linux-headers
WORKDIR /opt/claude-mem
COPY plugin/package.json plugin/bun.lock ./
RUN bun install --frozen-lockfile --production
# Rebuild native bindings against musl rather than copying glibc prebuilds.
# Node 24 headers require C++20; older grammar gyp files default to C++17.
RUN CXXFLAGS="-std=c++20" npm rebuild --build-from-source
ARG CLAUDE_CODE_VERSION=2.1.283
RUN npm install --prefix /opt/claude-cli --omit=dev --no-audit --no-fund \
    @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

FROM base AS runtime
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
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    XDG_CACHE_HOME=/tmp/.cache \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
    DISABLE_AUTOUPDATER=1
USER 1000:1000
WORKDIR /home/node
EXPOSE 37877
ENTRYPOINT ["/usr/local/bin/claude-mem-entrypoint"]
CMD []
