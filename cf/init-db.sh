#!/bin/sh
# Replacement for the dev image's init-db.sh. The stock version is hardcoded to
# localhost and re-runs database:init:prod + upgrade against PG_DATABASE_URL on
# EVERY boot, which over a remote Neon connection never completes and blocks
# twenty-server from binding :2020. This version is external-DB aware.
set -e

step() { echo "==> $1"; }

# Local Postgres always runs in the all-in-one image; wait for it so the
# supervised service tree is healthy even when we point Twenty at Neon.
step "waiting for local postgres"
TRIES=0
until su-exec postgres pg_isready -h localhost >/dev/null 2>&1; do
  TRIES=$((TRIES + 1))
  [ "$TRIES" -ge 120 ] && { echo "ERROR: local postgres not ready in 60s"; exit 1; }
  sleep 0.5
done

IS_EXTERNAL=false
case "${PG_DATABASE_URL:-}" in
  *localhost*|"") IS_EXTERNAL=false ;;
  *) IS_EXTERNAL=true ;;
esac

if [ "$IS_EXTERNAL" = "false" ]; then
  # ---- Original all-in-one path: local postgres owns the data. ----
  su-exec postgres psql -h localhost -tc \
    "SELECT 1 FROM pg_roles WHERE rolname='twenty'" | grep -q 1 \
    || su-exec postgres psql -h localhost -c \
       "CREATE ROLE twenty WITH LOGIN PASSWORD 'twenty' SUPERUSER"
  su-exec postgres psql -h localhost -tc \
    "SELECT 1 FROM pg_database WHERE datname='default'" | grep -q 1 \
    || su-exec postgres createdb -h localhost -O twenty default

  cd /app/packages/twenty-server
  has_schema=$(PGPASSWORD=twenty psql -h localhost -U twenty -d default -tAc \
    "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name='core')")
  if [ "$has_schema" = "f" ]; then
    step "initial local db setup + migrations"
    yarn database:init:prod
  fi
  step "cache flush + upgrade (local)"
  yarn command:prod cache:flush || echo "warn: cache flush failed, continuing"
  yarn command:prod upgrade || echo "warn: upgrade had errors, continuing"
  yarn command:prod cache:flush || echo "warn: cache flush failed, continuing"
  exit 0
fi

# ---- External Postgres (Neon) path: Neon owns the data. ----
cd /app/packages/twenty-server
step "checking Neon schema"
has_schema=$(psql "$PG_DATABASE_URL" -tAc \
  "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name='core')" \
  2>/dev/null || echo "error")

if [ "$has_schema" = "t" ]; then
  # Database upgrades are exclusively owned by the Cloudflare release
  # Workflow. Normal starts only verify that the external schema exists.
  step "Neon already initialized — skipping init, starting server"
  exit 0
fi

echo "ERROR: external PostgreSQL schema is absent or unreachable"
echo "Run the Cloudflare-controlled release Workflow; normal startup will not initialize Neon."
exit 1
