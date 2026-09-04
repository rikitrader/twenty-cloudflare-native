# Redis-free Worker rollback and queue reconciliation

## Runtime sequence

1. Pause or rate-limit new producers if the incident requires it.
2. Run `wrangler rollback` for the affected Worker version. Do not change
   `REDIS_BACKEND`; Cloudflare remains the only supported coordination backend.
3. The previous Worker version resumes against the same Durable Object,
   Queue, scheduler, and pub/sub state.
4. Reconcile every pre-rollback Cloudflare receipt and wait for its Queue
   backlog to reach its pre-drill baseline. Any increase or missing receipt is
   a failed rollback and requires quarantine before replay.
5. Verify DLQ count, oldest age, execution receipts, and application side
   effects. Do not blindly replay an ambiguous receipt.
6. Keep the old Cloudflare consumer until the exposure window is closed.

## Drill

```sh
npm run test:g12:rollback
```

The drill deploys a Redis-free canary checkpoint, creates 25 delayed Cloudflare
jobs, rolls the Worker back one version, verifies the backend remains
Cloudflare, verifies every receipt, checks DLQ/backlog reconciliation, records
timing, checks the immutable production version, and restores the current
Redis-free canary in cleanup.

Pass criteria are rollback completion under 15 minutes, no missing tracked
jobs, no DLQ increase, and no queue backlog increase over the pre-drill
baseline. A pre-existing backlog is reported as baseline.
