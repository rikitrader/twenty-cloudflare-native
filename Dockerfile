# Thin wrapper over the official all-in-one image: adds the Cloudflare backup
# agent (:2021) and restore-on-boot support. Zero changes to Twenty itself.
FROM twentycrm/twenty-app-dev:v2.20
COPY cf/ /cf/
RUN chmod +x /cf/boot.sh /cf/restore.sh /cf/init-db.sh
# Override the image's init-db.sh: the stock version is hardcoded to localhost
# and re-runs migrations/upgrade against PG_DATABASE_URL every boot, which never
# completes over a remote Neon connection. Ours skips init when Neon's schema
# already exists so twenty-server binds :2020 immediately.
RUN cp /cf/init-db.sh /etc/s6-overlay/scripts/init-db.sh && chmod +x /etc/s6-overlay/scripts/init-db.sh
# Entrypoint stays /init; the Worker's Container class overrides it to /cf/boot.sh,
# which starts the agent and then execs /init (s6) unchanged.
LABEL cf.twenty.mode="hybrid-neon-5"
