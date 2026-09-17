# Job failure and dead-letter operations

D1 is the searchable failure/audit ledger and Cloudflare Queues are the durable
transport. Messages use deterministic IDs and execution receipts so duplicate
delivery cannot repeat a completed side effect.

Triage oldest failures first. Inspect the failure reason and provider state,
record an operator note, then use the authenticated replay endpoint. Ambiguous
external outcomes require reconciliation before replay. Never change an
expected version merely to bypass a conflict.

If replay controls are suspected: rotate the operator credential, disable the
operations route, keep Queue ingestion active, reconcile all pending IDs, and
roll back only after preserving the audit evidence.
