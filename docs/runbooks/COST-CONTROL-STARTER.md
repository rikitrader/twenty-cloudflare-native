# Cloudflare-native starter cost controls

The starter profile intentionally excludes PostgreSQL, Redis, Hyperdrive,
Containers, persistent local disks, and external application hosting.

Run the executable guard with:

```bash
npm run cost:starter:check
```

The guard validates both the reference production configuration and the
portable example configuration. It requires:

- exactly two D1 bindings (`CRM_DB` and `OPS_DB`);
- one R2 binding for tenant files, transfers, and backups;
- KV only for disposable status state;
- bounded event, job, and dead-letter Queues;
- backup, import, and export Workflows;
- state, scheduler, and pubsub Durable Objects;
- Static Assets served behind the Worker;
- query-string-redacted Worker observability;
- scheduled maintenance and continuity triggers;
- no Container, Hyperdrive, external SQL, or Redis runtime dependency.

## Cost controls for forks

- Start with conservative Queue batch sizes and concurrency.
- Keep trace sampling below full volume unless debugging a bounded incident.
- Review every Cron Trigger; the reference schedules serve distinct scheduler,
  continuity, and backup responsibilities.
- Apply lifecycle/retention policies to R2 artifacts and GitHub evidence.
- Keep AI and Email bindings optional and expose disabled states explicitly.
- Add account budgets and alerts before enabling high-volume providers,
  imports, exports, or AI use.

This check validates architecture, not a fixed bill. Cloudflare prices,
included quotas, and product availability vary by plan and can change; review
the current Cloudflare dashboard and official pricing before deployment.
