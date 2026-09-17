# Starter-scale cost control

Attribute usage by Cloudflare resource before optimizing. Production uses one
Worker plus D1, R2, KV, Queues, Workflows, Durable Objects, Email, and Workers
AI bindings. Use bounded queries, indexed filters, Queue batching, explicit R2
retention, and sampled observability outside incident windows.

Create account budget alerts and review D1 rows read/written, R2 operations,
Queue backlog, Workflow duration, DO requests, and Worker CPU after releases.
Never delete a database, bucket, queue, audit ledger, or backup as a cost
measure without a verified export and recovery test.
