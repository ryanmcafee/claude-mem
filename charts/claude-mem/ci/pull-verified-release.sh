#!/usr/bin/env bash
# Fetch a signed chart by immutable OCI digest for a local Helm install.
set -euo pipefail

if [[ $# != 4 ]]; then
  echo "usage: $0 <version> <sha256:digest> <expected-workflow-identity> <output.tgz>" >&2
  exit 2
fi

version=$1
digest=$2
identity=$3
output=$4
chart=ghcr.io/ryanmcafee/charts/claude-mem

if [[ ! $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ || ! $digest =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "expected a semver release and a sha256 OCI manifest digest" >&2
  exit 2
fi
if [[ $identity != "https://github.com/ryanmcafee/claude-mem/.github/workflows/container-publish.yml@refs/tags/$version" &&
      $identity != "https://github.com/ryanmcafee/claude-mem/.github/workflows/container-publish.yml@refs/tags/v$version" ]]; then
  echo "expected the trusted release workflow identity at a tag" >&2
  exit 2
fi

subject="$chart@$digest"
cosign verify --certificate-identity "$identity" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  "$subject" >/dev/null || {
    echo "chart signature verification failed for $subject" >&2
    exit 1
  }

manifest=$(oras manifest fetch "$subject")
layer=$(jq -er '[.layers[] | select(.mediaType == "application/vnd.cncf.helm.chart.content.v1.tar+gzip") | .digest] | if length == 1 then .[0] else error("expected one Helm chart layer") end' <<<"$manifest")
tmpdir=$(mktemp -d)
tmp="$tmpdir/claude-mem-$version.tgz"
trap 'rm -rf "$tmpdir"' EXIT
oras blob fetch --output "$tmp" "$chart@$layer"
printf '%s  %s\n' "${layer#sha256:}" "$tmp" | sha256sum --check --status || {
  echo "chart layer digest mismatch" >&2
  exit 1
}
actual_version=$(helm show chart "$tmp" | sed -n 's/^version: *//p' | tr -d '"')
actual_app_version=$(helm show chart "$tmp" | sed -n 's/^appVersion: *//p' | tr -d '"')
if [[ $actual_version != "$version" || $actual_app_version != "$version" ]]; then
  echo "chart version/appVersion does not match $version" >&2
  exit 1
fi
mv -f "$tmp" "$output"
rm -rf "$tmpdir"
trap - EXIT
echo "verified chart saved to $output"
