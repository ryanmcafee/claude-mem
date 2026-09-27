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
input=$(python3 - "$1" "$scratch/layout" <<'PYTHON'
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
report=${CONTAINER_SCAN_REPORT:-$scratch/report.json}
# No ignore-unfixed, ignore file, advisory mode, or swallowed scanner errors.
set +e
trivy image --config /dev/null --ignorefile /dev/null \
  --scanners vuln --severity HIGH,CRITICAL --exit-code 1 --timeout 15m \
  --list-all-pkgs --format json --output "$report" --input "$input"
result=$?
set -e
# Fail closed if the scanner reports nothing because initialization or package
# discovery failed. A valid report with findings must still return nonzero.
python3 - "$report" <<'PYTHON'
import json, sys
from pathlib import Path
path = Path(sys.argv[1])
if not path.is_file():
    sys.exit('Trivy produced no report; fix the scanner/input error above.')
report = json.loads(path.read_text())
if not report.get('Metadata', {}).get('OS', {}).get('Family'):
    sys.exit('Trivy did not detect the image OS; refusing an empty scan.')
packages = sum(len(r.get('Packages', [])) for r in report.get('Results', []))
if packages == 0:
    sys.exit('Trivy detected zero packages; refusing an empty scan.')
print(f'Trivy detected {packages} packages; OS={report["Metadata"]["OS"]["Family"]}')
PYTHON
trivy convert --format table "$report"
if [[ "$result" != 0 ]]; then
  echo 'Image gate failed. Update affected base/dependencies for HIGH/CRITICAL findings, or fix the scanner error above.' >&2
fi
exit "$result"
