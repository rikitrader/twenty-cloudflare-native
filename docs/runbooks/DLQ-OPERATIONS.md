# Job failure and DLQ operations

Status: implemented and verified behind a path-scoped Cloudflare Access
application in the isolated canary. Human and service-token authentication
have both passed live. Restricted email alert delivery and bounded bulk replay
have also passed live. The full procedure then passed against isolated
production-topology staging with separate server and worker Containers.

## Safety model

- The Cloudflare Queue DLQ is a durable transport buffer. D1 is the searchable
  operations and audit ledger.
- Application quarantines use deterministic failure IDs. A redelivered Queue
  message updates `delivery_count`; it does not create a second case.
- Every failure starts in `quarantined`.
- List responses omit job payloads. Payloads are returned only by the
  authenticated single-case endpoint.
- Mutations require a bearer `OPS_TOKEN`, an operator identity, a note, and the
  current record version.
- Replaying `executor-outcome-ambiguous` requires
  `confirmUncertainOutcome: true` after the operator reconciles PostgreSQL,
  external provider state, or the outbox.
- Replay uses a stable new job ID. If D1 finalization fails after Queue
  persistence, retrying the operation sends the same ID; the execution receipt
  prevents a second handler execution.
- Failed Queue persistence returns the case to `quarantined` and writes a
  `replay_failed` audit event.
- Automation uses a specific Cloudflare Access Service Auth token. Its secret
  exists only as encrypted bindings on the path-constrained G9 probe Worker.
  The operations Worker still validates the Access JWT signature, issuer,
  audience, expiry, application type, and service `common_name`.

## Endpoints

All responses use `Cache-Control: no-store`.

```text
GET  /_ops/job-failures/summary
GET  /_ops/job-failures?status=quarantined&limit=25&cursor=...
GET  /_ops/job-failures/:failureId
POST /_ops/job-failures/:failureId/replay
POST /_ops/job-failures/:failureId/dismiss
POST /_ops/job-failures/bulk-replay
```

Mutation headers:

```text
Authorization: Bearer <OPS_TOKEN>
X-Ops-Actor: <on-call identity>
Content-Type: application/json
```

Replay body:

```json
{
  "expectedVersion": 1,
  "note": "Reconciled provider and PostgreSQL state; no side effect committed",
  "confirmUncertainOutcome": true
}
```

Dismiss body:

```json
{
  "expectedVersion": 1,
  "note": "Invalid legacy envelope; no replay is possible"
}
```

Bounded bulk replay body:

```json
{
  "requestId": "incident-2026-07-25-batch-01",
  "note": "All selected cases reconciled against PostgreSQL and providers",
  "confirmBulkReplay": true,
  "items": [
    {
      "id": "failure:...",
      "expectedVersion": 1,
      "confirmUncertainOutcome": true
    }
  ]
}
```

Bulk replay accepts 1-10 unique cases. It validates every case before the first
enqueue, requires each current version, and stops on the first conflict that
appears after preflight. Every individual replay keeps its own execution
receipt and audit chain; `bulkRequestId` links the audit events. A `409`
preflight response guarantees that the request enqueued no jobs. A `207`
response means only the listed attempted cases may have changed and must be
reconciled before another request.

Never retry a `409` by changing the version blindly. Fetch the case again,
review intervening audit events, and repeat the reconciliation decision.

## Triage

1. Read `/_ops/job-failures/summary`.
2. Compare job and DLQ `backlogCount`, `backlogBytes`, and
   `oldestMessageTimestamp`.
3. Inspect `quarantined` and `replay_pending` cases oldest first.
4. Classify the failure:
   - invalid envelope: correct the producer; usually dismiss;
   - permanent executor response: correct data/code, then replay;
   - retry limit exceeded: verify dependency recovery, then replay;
   - ambiguous outcome: reconcile the side effect before any replay;
   - platform retry exhausted: determine why the consumer could not persist or
     route the original message.
5. Record the decision in the mutation note.
6. Verify the new job ID completes and the case contains
   `replay_requested` plus `replay_enqueued`.

## Alert thresholds for production configuration

These thresholds are rollout defaults and must be calibrated from the 5x load
test:

- critical: any `replay_pending` case older than 15 minutes;
- critical: DLQ backlog older than 10 minutes;
- high: job queue oldest age above 5 minutes for two consecutive probes;
- high: any new `executor-outcome-ambiguous` case;
- warning: quarantined count increases in two consecutive five-minute probes.

The Worker evaluates queue age and executor readiness every five minutes.
Active fingerprints send immediately and repeat after 30 minutes; a transition
back to healthy sends a recovery email. The email binding is restricted to
`twenty-alerts@sismo911.com` and `rikitrader@gmail.com`. The isolated canary
exercised all three synthetic threshold codes through the live binding. The
production-topology staging drill also passed, so G9 is `passed`.

The canary service credential has a Cloudflare email notification policy seven
days before expiry. This prevents silent probe credential expiration but does
not replace the queue-age and executor-readiness alerts above.

## Rollback

Removing the DLQ consumer stops D1 ingestion without deleting Queue messages.
Do not delete either queue or the D1 database. If the operations API is
suspected of incorrect replay:

1. revoke or rotate `OPS_TOKEN`;
2. disable the operations route at the edge;
3. keep the DLQ consumer running so failures remain durable and searchable;
4. reconcile every `replay_pending` record using its stable `replay_job_id`;
5. roll back the Worker version only after recording the affected IDs.
