#!/usr/bin/env bash
# One local entrypoint: build, prove read-only runtime behavior, and scan.
set -euo pipefail
image=${1:-claude-mem:check}
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
docker buildx build --file docker/claude-mem/Dockerfile --load --tag "$image" .
bash scripts/container/smoke.sh "$image"
docker save --output "$scratch/image.tar" "$image"
bash scripts/container/scan.sh "$scratch/image.tar"
