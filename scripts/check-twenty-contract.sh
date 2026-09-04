#!/usr/bin/env bash
set -Eeuo pipefail

REPO_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
IMAGE="twentycrm/twenty@sha256:cd812094cd3439e91deaf727470ecb302129447306200fff853ba0d7e9609079"

docker run --rm \
  --entrypoint node \
  --volume "$REPO_DIR:/workspace:ro" \
  "$IMAGE" \
  /workspace/scripts/inventory-twenty-contract.mjs \
  --root /app/packages/twenty-server/dist \
  --package-root /app \
  --check /workspace/docs/twenty-v2.24.1-contract.json
