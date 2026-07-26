#!/usr/bin/env bash
set -Eeuo pipefail

dockerfile="${1:-Dockerfile.production}"
source_date_epoch="${SOURCE_DATE_EPOCH:-0}"
workdir="$(mktemp -d)"
temp_root="${TMPDIR:-/tmp}"
temp_root="${temp_root%/}"

cleanup() {
  case "$workdir" in
    /tmp/* | /private/tmp/* | "$temp_root"/*)
      rm -rf -- "$workdir"
      ;;
    *)
      echo "refusing unsafe cleanup path: $workdir" >&2
      ;;
  esac
}
trap cleanup EXIT

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

build_once() {
  destination="$1"
  docker buildx build \
    --no-cache \
    --provenance=false \
    --sbom=false \
    --build-arg "SOURCE_DATE_EPOCH=${source_date_epoch}" \
    --output "type=oci,dest=${destination},rewrite-timestamp=true" \
    --file "$dockerfile" \
    .
}

first="${workdir}/first.oci.tar"
second="${workdir}/second.oci.tar"
build_once "$first"
build_once "$second"

first_digest="$(hash_file "$first")"
second_digest="$(hash_file "$second")"
if [[ "$first_digest" != "$second_digest" ]]; then
  echo "non-reproducible image: ${first_digest} != ${second_digest}" >&2
  exit 1
fi

printf '%s\n' \
  "{" \
  "  \"dockerfile\": \"${dockerfile}\"," \
  "  \"sourceDateEpoch\": ${source_date_epoch}," \
  "  \"firstOciSha256\": \"${first_digest}\"," \
  "  \"secondOciSha256\": \"${second_digest}\"," \
  "  \"reproducible\": true" \
  "}"
