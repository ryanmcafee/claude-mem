#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 || ! -s "$1" ]]; then
  echo 'Usage: scripts/container/scan.sh <non-empty OCI image archive>; build the image first.' >&2
  exit 2
fi
# No ignore-unfixed, ignore file, advisory mode, or swallowed scanner errors.
# An empty ignore file prevents ambient repository configuration from weakening
# the release gate. The same command gates PR and release archives.
trivy image --config /dev/null --ignorefile /dev/null \
  --scanners vuln --severity HIGH,CRITICAL --exit-code 1 --timeout 15m \
  --input "$1"
