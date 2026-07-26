# Cloudflare-native Twenty threat model

Status: living release-gate document. Scope is the Redis/BullMQ replacement,
its operational plane, and the trust boundary between Twenty Containers and
Cloudflare services.

## Assets and trust boundaries

Protected assets:

- Twenty CRM data in external PostgreSQL;
- sessions, locks, execution receipts, schedules, and pub/sub state in Durable
  Objects;
- job and event envelopes in Cloudflare Queues;
- operational failure payloads and audit history in D1;
- attachments and recovery exports in R2;
- Access, application, database, storage, webhook, backup, canary, and internal
  service credentials.

Trust boundaries:

1. Internet client to Cloudflare Access/WAF.
2. Access/WAF to the public Worker.
3. Worker to D1, Queues, Durable Objects, R2, Workflows, and Containers through
   typed bindings.
4. Twenty code inside a Container to the Worker’s host-intercepted
   `*.internal` gateways.
5. Worker/Container to external PostgreSQL and third-party job side effects.

The `*.internal` names are outbound host interceptions on Container classes;
they are not DNS hostnames or public Worker routes.

## Threats and controls

| Threat | Control | Evidence/state |
| --- | --- | --- |
| Unauthenticated DLQ inspection or replay | Path-scoped Access app, exact-email allow policy, Worker-side JWT verification, separate bearer token | Live canary perimeter; `src/access.ts` |
| Forged/stale Access assertion | Remote JWKS, RS256 allowlist, exact issuer/audience, required `exp`/`iat`/`sub` | `test/access.test.ts` |
| Bearer theft alone authorizes replay | Access identity and bearer are both required | `src/job-failures.ts` |
| Operations brute force or API abuse | Per-identity Workers Rate Limiting binding, 60 requests/minute | Wrangler configs and security tests |
| CSRF/token reuse from an unrelated site | Access binding cookie, bearer header, POST-only mutations, no-store/API security headers | Canary Access app and API code |
| Replay repeats an uncertain external side effect | Durable quarantine, reconciliation note, optimistic version, explicit ambiguous-outcome confirmation | G4/G9 canaries |
| Duplicate DLQ delivery creates duplicate cases | SHA-256 deterministic failure ID plus D1 upsert | G9 canary |
| Queue message poisoning | Versioned bounded envelope validator; invalid messages quarantine | Job tests |
| Public invocation of state/queue/pubsub gateway | Gateway exists only in Container outbound interception and requires internal bearer | `src/containers.ts`, gateway handlers |
| Webhook credential disclosure in logs | Query credentials rejected; bearer header only | `src/queue.ts` |
| Job payload disclosure in list/metrics APIs | List and summary omit `job_json`; detail remains Access protected | G9 canary |
| Secret committed in configuration | Config tests reject token variables; secrets use Worker secret bindings | `test/security-config.test.ts` |
| Dependency compromise or known vulnerability | Frozen lockfile, pinned base image digests, `bun audit`, contract anchors | CI and G0 evidence |
| Access path bypass through overlap | Public-destination Access app is scoped to `/_ops/*`; unauthenticated live request redirects while `/_canary/*` reaches Worker | G10 evidence |

## Required production controls

The canary controls do not authorize production activation. Before G10 can
pass:

1. Create a separate production `/_ops/*` Access application and set its
   unique audience in the production Worker.
2. Replace one-time PIN with the organization IdP, require phishing-resistant
   MFA for operators, and use an IdP/SCIM group rather than one email.
3. Create a Service Auth policy and separately managed service token for
   monitoring; never share the human bearer token.
4. Configure WAF managed rules and route-specific rate limits on the production
   custom domain.
5. Export Access authentication, Worker, and mutation audit logs to the
   organization SIEM or immutable R2 log bucket.
6. Rotate and inventory every Worker, PostgreSQL, R2, webhook, and application
   secret; prove least-privilege scopes and revocation.
7. Run authorized, unauthorized, expired-token, wrong-audience, rate-limit,
   and policy-removal recovery tests in production-topology staging.

## Incident response

- Suspected operations-token exposure: rotate `OPS_TOKEN`, revoke Access
  sessions for the application, inspect Access authentication logs and the D1
  audit ledger, and reconcile every mutation in the exposure window.
- Suspected internal-service-token exposure: rotate it, restart Containers,
  pause producers, and inspect Queue plus execution receipts before resuming.
- Suspected Access misconfiguration: rotate `OPS_TOKEN` first, then remove or
  disable the Access application only during a controlled rollback; the
  Worker-side JWT check remains fail-closed when `ACCESS_REQUIRED=true`.
- Suspected malicious job: pause the affected producer/consumer, preserve the
  Queue/DLQ and D1 records, and do not replay until its side effects are
  reconciled.
