# Redis-free canary image uses the same production artifact as the live
# server/worker. Never derive a deployable image from Twenty's all-in-one
# development image because that image bakes in Redis configuration.
FROM twentycrm/twenty@sha256:cd812094cd3439e91deaf727470ecb302129447306200fff853ba0d7e9609079
USER root
COPY cf/ /cf/
# Keep the auth patch as a distinct build input so Docker cannot reuse a stale
# aggregate cf/ layer after a security patch changes.
COPY cf/patch-frontend-auth-revocation.cjs /cf/patch-frontend-auth-revocation.cjs
RUN chmod +x /cf/boot.sh /cf/restore.sh /cf/init-db.sh
# Keep the isolated canary on the same exact security patch set as production.
RUN apk add --no-cache \
  c-ares=1.34.8-r0 \
  curl=8.20.0-r0 \
  libcurl=8.20.0-r0 && \
  rm -f /var/log/apk.log && \
  chmod +x /cf/patch-vulnerable-node-packages.sh && \
  /cf/patch-vulnerable-node-packages.sh
USER 1000
# Twenty exposes generic delete commands for Workflow Runs but its own v2.24.1
# query hooks reject both mutations unconditionally. Let the normal resolver
# handle them so role permissions still apply and the UI can soft-delete runs.
RUN node /cf/patch-workflow-run-delete.cjs
# The adapters remain dormant unless REDIS_BACKEND=cloudflare. Baking them into
# the canary image lets the isolated Worker exercise the same application
# contracts without adding another coordination service.
RUN node /cf/patch-cloudflare-state-adapters.cjs
RUN echo "frontend-auth-revocation-patch-v1" && node /cf/patch-frontend-auth-revocation.cjs
# Neon persists file metadata, but Cloudflare Container disks are ephemeral.
# Rehydrate the workflow's three existing logic-function sources from the image
# so Twenty can build them after every container restart.
COPY --chown=1000:1000 cf/workflow-sources/ \
  /app/packages/twenty-server/.local-storage/1e5ecbe5-5f33-4336-8c99-a205527ab176/55d2c82e-ffe9-43e7-9338-af1dea62c1ed/source/
# Twenty always downloads package.json before building a logic function. Seed
# both installed applications from the exact dependency files shipped in v2.24.1.
RUN set -eu; \
  seed=/app/packages/twenty-server/dist/assets/engine/core-modules/application/application-package/constants/seed-dependencies; \
  root=/app/packages/twenty-server/.local-storage/1e5ecbe5-5f33-4336-8c99-a205527ab176; \
  for app in 55d2c82e-ffe9-43e7-9338-af1dea62c1ed 20202020-64aa-4b6f-b003-9c74b97cee20; do \
    mkdir -p "$root/$app/dependencies"; \
    cp "$seed/package.json" "$seed/yarn.lock" "$root/$app/dependencies/"; \
  done; \
  chown -R 1000:1000 "$root"
LABEL cf.twenty.mode="canary-redis-free-v1"
