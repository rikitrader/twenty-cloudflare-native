#!/bin/sh
# Restore /tmp/restore.sql into the live Postgres, then bounce Twenty's node
# processes so they reload against the restored data. s6 respawns them.
set -e
URL="${PG_DATABASE_URL:-postgres://twenty:twenty@localhost:5432/default}"
ADMIN="${URL%/*}/postgres"

i=0
until pg_isready -h localhost -q || [ "$i" -ge 90 ]; do i=$((i+1)); sleep 1; done
pg_isready -h localhost -q || { echo "postgres never became ready"; exit 1; }

psql "$ADMIN" -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='default' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
psql "$ADMIN" -v ON_ERROR_STOP=1 -c 'DROP DATABASE IF EXISTS "default" WITH (FORCE);'
psql "$ADMIN" -v ON_ERROR_STOP=1 -c 'CREATE DATABASE "default";'
psql "$URL" -q -v ON_ERROR_STOP=0 -f /tmp/restore.sql >/dev/null

redis-cli flushall >/dev/null 2>&1 || true
date -u +%Y-%m-%dT%H:%M:%SZ > /tmp/cf-restore-settled

# Bounce Twenty's node processes (server + worker); s6 restarts them clean.
pkill -f "node.*dist" || true
echo "restore complete"
