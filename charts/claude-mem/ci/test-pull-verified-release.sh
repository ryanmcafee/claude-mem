#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/../../.." && pwd)
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
mkdir "$test_dir/bin"
printf 'chart fixture\n' > "$test_dir/chart.tgz"
layer="sha256:$(sha256sum "$test_dir/chart.tgz" | cut -d ' ' -f 1)"
manifest_digest="sha256:$(printf 'a%.0s' {1..64})"
version=13.28.0
identity="https://github.com/ryanmcafee/claude-mem/.github/workflows/container-publish.yml@refs/tags/v$version"
chart=ghcr.io/ryanmcafee/charts/claude-mem
export LAYER_DIGEST="$layer" SOURCE_CHART="$test_dir/chart.tgz" EXPECTED_SUBJECT="$chart@$manifest_digest" VERSION="$version"

cat > "$test_dir/bin/cosign" <<'EOF'
#!/usr/bin/env bash
[[ ${REJECT_SIGNATURE:-0} == 0 && ${*: -1} == "$EXPECTED_SUBJECT" ]]
EOF
cat > "$test_dir/bin/oras" <<'EOF'
#!/usr/bin/env bash
if [[ $1 == manifest && $2 == fetch ]]; then
  printf '{"layers":[{"mediaType":"application/vnd.cncf.helm.chart.content.v1.tar+gzip","digest":"%s"}]}\n' "$LAYER_DIGEST"
elif [[ $1 == blob && $2 == fetch ]]; then
  cp "$SOURCE_CHART" "$4"
else
  exit 2
fi
EOF
cat > "$test_dir/bin/helm" <<'EOF'
#!/usr/bin/env bash
printf 'version: %s\nappVersion: %s\n' "$VERSION" "$VERSION"
EOF
chmod +x "$test_dir/bin/"*
export PATH="$test_dir/bin:$PATH"
# The agent harness may reset PATH in every child Bash process.
export BASH_ENV=
output="$test_dir/release.tgz"
helper="$repo_root/charts/claude-mem/ci/pull-verified-release.sh"

bash "$helper" "$version" "$manifest_digest" "$identity" "$output"
cmp "$test_dir/chart.tgz" "$output"
printf 'previous package\n' > "$output"

if REJECT_SIGNATURE=1 bash "$helper" "$version" "$manifest_digest" "$identity" "$output"; then
  echo 'unsigned chart was accepted' >&2
  exit 1
fi
[[ $(cat "$output") == 'previous package' ]]

swapped="sha256:$(printf 'b%.0s' {1..64})"
if bash "$helper" "$version" "$swapped" "$identity" "$output"; then
  echo 'swapped chart digest was accepted' >&2
  exit 1
fi
[[ $(cat "$output") == 'previous package' ]]
echo 'verified chart accepted; unsigned and swapped manifests rejected'
