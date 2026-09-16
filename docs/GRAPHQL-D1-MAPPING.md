# Twenty GraphQL → Cloudflare D1 mapping

The production `/graphql` handler is `src/graphql-compat.ts`. Every request is
authenticated with Cloudflare Access and checked against `workspace_members`
before a resolver is executed.

## D1-backed families

| Upstream family | Cloudflare storage/execution |
|---|---|
| People, companies, opportunities, activities | `contacts`, `companies`, `opportunities`, `activities` |
| Generic custom objects/records | `custom_objects`, `custom_records` |
| Relationships | `record_relationships` |
| Metadata and fields | `custom_objects`, `custom_fields` |
| Views and page layouts | `saved_views`, `workspace_settings` |
| Workspace roles/invitations | `workspace_members`, `workspace_invitations` |
| Sessions and API keys | `native_sessions`, `native_api_keys` |
| Webhooks and integrations | `native_webhooks`, `integration_accounts` |
| Billing/resource credits | `workspace_billing` |
| Chat threads/messages | `ai_chat_threads`, `ai_chat_messages` |
| Audit logs and admin users | `crm_audit_events`, `workspace_members` |
| Files and timeline activities | `crm_files`, `activities`, R2 |

These families support reads, writes, pagination, filtering, sorting, and
tenant-scoped authorization where the underlying table supports the feature.
Bulk record mutations are bounded to 60 records, matching Twenty's API limit.

## Cloudflare execution families

Workflow, retry, email, channel-sync, and chat-send operations are durably
queued through `JOBS_QUEUE`. The queue consumer provides retry and dead-letter
handling; resolvers never depend on an always-running server.

## Explicit provider-dependent gaps

Billing checkout/payment-provider sessions, marketplace installation packages,
AI model execution, enterprise licensing, and external OAuth/SMTP delivery
require provider credentials or application-specific secrets. The adapter
returns stable nullable GraphQL fields for those operations and never invents
records. Adding a provider implementation must add a D1 state table and an
idempotent queue/workflow handler before enabling the operation.
