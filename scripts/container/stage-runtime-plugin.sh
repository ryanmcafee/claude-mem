#!/usr/bin/env bash
# Stage only reviewed plugin files. Extra files in the build checkout must not
# cross into the published image, even inside a normally shipped directory.
set -euo pipefail
source_root=${1:?Usage: stage-runtime-plugin.sh SOURCE_ROOT DESTINATION MANIFEST}
destination=${2:?Usage: stage-runtime-plugin.sh SOURCE_ROOT DESTINATION MANIFEST}
manifest=${3:?Usage: stage-runtime-plugin.sh SOURCE_ROOT DESTINATION MANIFEST}
mkdir -p "$destination"
while IFS= read -r path || [[ -n "$path" ]]; do
  [[ -z "$path" || "$path" == \#* ]] && continue
  if [[ "$path" = /* || "$path" == *..* || "$path" == *//* ]]; then
    echo "Invalid runtime plugin allowlist path: $path" >&2
    exit 1
  fi
  if [[ ! -f "$source_root/$path" || -L "$source_root/$path" ]]; then
    echo "Missing or symlinked runtime plugin file: $path" >&2
    exit 1
  fi
  mkdir -p "$destination/$(dirname "$path")"
  cp "$source_root/$path" "$destination/$path"
done < "$manifest"
