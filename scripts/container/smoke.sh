#!/usr/bin/env bash
set -euo pipefail
image=${1:?Usage: scripts/container/smoke.sh IMAGE}
# Use the production entrypoint with precisely the chart's writable mounts.
# No credentials, provider traffic, or metered API calls are needed.
docker run --rm --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,uid=1000,gid=1000,mode=1777 \
  --tmpfs /home/node/.claude:rw,nosuid,nodev,uid=1000,gid=1000 \
  --tmpfs /home/node/.claude-mem:rw,nosuid,nodev,uid=1000,gid=1000 \
  --tmpfs /data/claude-mem:rw,nosuid,nodev,uid=1000,gid=1000 \
  --env CLAUDE_MEM_CONTAINER_MODE=shell "$image" bash -euo pipefail -c '
    test "$(id -u)" = 1000
    for tool in cc gcc g++ make npm npx yarn yarnpkg; do
      if command -v "$tool"; then echo "Unexpected build tool in runtime: $tool" >&2; exit 1; fi
    done
    for path in /tmp /home/node/.claude /home/node/.claude-mem /data/claude-mem; do
      touch "$path/.writable-probe"
    done
    if touch /opt/claude-mem/.immutable-probe 2>/dev/null; then
      echo "Application installation must be immutable" >&2; exit 1
    fi
    bun --version
    claude --version
    # Execute the bundled CLI to catch missing native/runtime dependencies.
    bun /opt/claude-mem/scripts/server-service.cjs status
  '

# Exercise actual HTTP startup and Postgres migrations under the same mounts.
# The password is disposable test data, generated per invocation.
name="claude-mem-smoke-$$"
password=$(openssl rand -hex 24)
cleanup() {
  docker rm -f "$name-server" "$name-db" "$name-redis" >/dev/null 2>&1 || true
  docker network rm "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker network create "$name" >/dev/null
docker run --detach --name "$name-db" --network "$name" --network-alias db \
  --env POSTGRES_USER=smoke --env POSTGRES_DB=smoke --env POSTGRES_PASSWORD="$password" \
  postgres:17-alpine >/dev/null
docker run --detach --name "$name-redis" --network "$name" --network-alias redis \
  valkey/valkey:8-alpine valkey-server --maxmemory-policy noeviction >/dev/null
ready=false
for ((i=0; i<60; i++)); do
  if docker exec "$name-db" pg_isready -U smoke -d smoke >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then echo 'Smoke Postgres did not become ready in 60s' >&2; exit 1; fi
docker run --detach --name "$name-server" --network "$name" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,nodev,uid=1000,gid=1000,mode=1777 \
  --tmpfs /home/node/.claude:rw,nosuid,nodev,uid=1000,gid=1000 \
  --tmpfs /home/node/.claude-mem:rw,nosuid,nodev,uid=1000,gid=1000 \
  --tmpfs /data/claude-mem:rw,nosuid,nodev,uid=1000,gid=1000 \
  --env CLAUDE_MEM_SERVER_HOST=0.0.0.0 --env CLAUDE_MEM_SERVER_PORT=37877 \
  --env CLAUDE_MEM_QUEUE_ENGINE=bullmq --env CLAUDE_MEM_AUTH_MODE=api-key \
  --env CLAUDE_MEM_SERVER_DATABASE_URL="postgres://smoke:$password@db:5432/smoke" \
  --env CLAUDE_MEM_REDIS_URL=redis://redis:6379 --env CLAUDE_MEM_REDIS_MODE=docker \
  --env CLAUDE_MEM_GENERATION_DISABLED=true --env CLAUDE_MEM_CHROMA_ENABLED=false \
  "$image" >/dev/null
for ((i=0; i<90; i++)); do
  if docker exec "$name-server" curl -fsS http://127.0.0.1:37877/healthz; then
    echo 'Non-root, read-only HTTP runtime reached /healthz with Postgres and Valkey.'
    exit 0
  fi
  if [[ $(docker inspect --format '{{.State.Running}}' "$name-server") != true ]]; then break; fi
  sleep 1
done
docker logs "$name-server" >&2
echo 'Read-only runtime failed /healthz; inspect startup errors above and writable mounts in docker/claude-mem/README.md.' >&2
exit 1
