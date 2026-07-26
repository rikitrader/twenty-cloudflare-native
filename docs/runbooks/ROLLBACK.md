# Backend rollback and queue reconciliation

## Runtime sequence

1. Pause or rate-limit new producers if the incident requires it.
2. Deploy `REDIS_BACKEND=redis` with `CLOUDFLARE_QUEUE_DRAIN=true`.
3. Redis/BullMQ owns new jobs and schedules. The rollback bridge registers the
   same handlers with a consumer-only Cloudflare driver.
4. Reconcile every pre-switch Cloudflare receipt and wait for its Queue
   backlog to reach its pre-drill baseline. Any increase or missing receipt is
   a failed rollback and requires quarantine before replay.
5. Verify DLQ count, oldest age, execution receipts, and application side
   effects. Do not blindly replay an ambiguous receipt.
6. Keep the old Cloudflare consumer until the exposure window is closed.

## Drill

```sh
npm run test:g12:rollback
```

The drill creates 25 delayed Cloudflare jobs, performs the backend switch,
checks Redis status, verifies every receipt, checks DLQ/backlog reconciliation,
records timing, checks the immutable production version, and restores the
canary to Cloudflare in cleanup.

Pass criteria are rollback completion under 15 minutes, no missing tracked
jobs, no DLQ increase, and no queue backlog increase over the pre-drill
baseline. A pre-existing backlog is reported as baseline.
