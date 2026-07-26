#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
IMAGE="twentycrm/twenty@sha256:d3dd949725e6196c57dab66ebe83ba9cdd2561885c35f94ef20f9ae38cd6d333"

docker run --rm \
  --entrypoint node \
  --volume "$REPO_DIR:/workspace:ro" \
  "$IMAGE" \
  /workspace/scripts/inventory-twenty-contract.mjs \
  --root /app/packages/twenty-server/dist \
  --package-root /app \
  --check /workspace/docs/twenty-v2.20-contract.json
