#!/usr/bin/env bash
# Offline fixture only: never place a real token in a CI fixture.
set -euo pipefail
image=${1:?Usage: scripts/container/credentials-smoke.sh IMAGE}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
printf '{"fixture":"not-a-provider-credential"}\n' > "$scratch/source.json"
chmod 444 "$scratch/source.json"
original=$(sha256sum "$scratch/source.json")
mounts=(--read-only --cap-drop ALL --security-opt no-new-privileges
  --tmpfs /tmp:rw,nosuid,nodev,uid=1000,gid=1000,mode=1777
  --tmpfs /home/node/.claude:rw,nosuid,nodev,uid=1000,gid=1000
  --tmpfs /home/node/.claude-mem:rw,nosuid,nodev,uid=1000,gid=1000
  --mount "type=bind,src=$scratch/source.json,dst=/run/secrets/fixture.json,readonly"
  --env CLAUDE_MEM_CONTAINER_MODE=shell)
for config in /home/node/.claude /tmp/custom-claude; do
  docker run --rm "${mounts[@]}" --env CLAUDE_CONFIG_DIR="$config" \
    --env CLAUDE_MEM_CREDENTIALS_FILE=/run/secrets/fixture.json \
    "$image" bash -euo pipefail -c '
      destination="$CLAUDE_CONFIG_DIR/.credentials.json"
      cmp /run/secrets/fixture.json "$destination"
      test "$(stat -c %a "$destination")" = 600
      test "$(stat -c %u "$destination")" = 1000
      if echo changed >> /run/secrets/fixture.json 2>/dev/null; then
        echo "Credential source must be read-only" >&2; exit 1
      fi
      if [[ "$CLAUDE_CONFIG_DIR" != /home/node/.claude ]]; then
        test ! -e /home/node/.claude/.credentials.json
      fi
    '
done
set +e
docker run --rm "${mounts[@]}" --env CLAUDE_MEM_CREDENTIALS_FILE=/run/secrets/missing.json \
  "$image" true > "$scratch/missing.log" 2>&1
result=$?
set -e
test "$result" = 1
grep -F 'CLAUDE_MEM_CREDENTIALS_FILE set but file missing' "$scratch/missing.log"
test "$(sha256sum "$scratch/source.json")" = "$original"
echo 'Default/custom credential paths, mode 0600, read-only source, and missing-source failure pass.'
