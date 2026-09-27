#!/usr/bin/env bash
set -euo pipefail
if [[ $# != 1 || ! -s "$1" ]]; then
  echo 'Usage: scripts/container/scan.sh <non-empty OCI image archive>; build the image first.' >&2
  exit 2
fi
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
# Trivy accepts Docker archives but expects OCI layouts as directories. Unpack
# the exact OCI artifact; never convert/rebuild it or discard its attestations.
input=$(python3 - "$1" "$scratch" <<'PYTHON'
import pathlib, sys, tarfile
archive, scratch = sys.argv[1:]
with tarfile.open(archive) as tar:
    if 'oci-layout' in tar.getnames():
        tar.extractall(scratch, filter='data')
        print(scratch)
    else:
        print(pathlib.Path(archive).resolve())
PYTHON
)
# No ignore-unfixed, ignore file, advisory mode, or swallowed scanner errors.
# An empty ignore file prevents ambient repository configuration from weakening
# the release gate. The same command gates PR and release archives.
trivy image --config /dev/null --ignorefile /dev/null \
  --scanners vuln --severity HIGH,CRITICAL --exit-code 1 --timeout 15m \
  --input "$input"
