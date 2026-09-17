# Login repair — 2026-09-17

Status: follow-up deployed; read-only production checks passed. The expired production browser session now recovers to the sign-in page; a fresh production credential submission remains user-controlled.
Baseline: `4ae2af6`.

## Scoped emergency-release approval

On 2026-09-17 the user replied "go" to an explicit request to deploy only this
login repair while G3/G10/G13 remain open. This is a one-release exception, not
a passing result for those gates or authorization for unrelated changes.
The normal gated deployment command remains unchanged. This release uses the
existing Worker and bindings; it does not run D1 migrations, reset credentials,
create production accounts, or execute legal-acceptance actions.

Deployment completed 2026-09-17 (UTC): `8c551709-5b3b-417a-87b1-2478a2358799`.
Previous version: `807318bb-e339-4e0d-9e6c-333be09a86de`. Read-only live checks
confirmed the new version, corrected domain config, canonical HTML entry,
matching main/login asset hashes, no-store cache policy, correct unknown-email
results on all four GraphQL routes, same-origin public workspace URL, and 401
for an unauthenticated CRM query. No production data writes were performed.
The user subsequently reported `/metadata` 401/400 responses; production
credential submission and dashboard access are therefore NOT verified fixed.

## Follow-up release — user requested "deploy"

Deployed 2026-09-17: `6809027b-0019-48f6-b728-352e5bd151af` at the canonical
Worker URL. Immediate rollback target: `8c551709-5b3b-417a-87b1-2478a2358799`.
Use `pnpm exec wrangler rollback 8c551709-5b3b-417a-87b1-2478a2358799` only if
rollback is required; this code-only release made no schema/data migration.

Post-deployment checks passed against the live version: single-origin cookie
configuration, SHA-256 matching HTML/main/login assets, no-store headers,
unknown-email lookup on all four GraphQL paths, disabled analytics reporting
not collected, and 401 for unauthenticated object metadata. These checks made
no production account or CRM data writes. The status endpoint's hardcoded
`productionReady` field was not used as readiness evidence.

Existing signed-in Chrome profile: selected its CRM tab and refreshed it.
Before refresh the tab still displayed the older 8-character signup notice.
After refresh, computer-use returned no page tree and "Screenshot unavailable";
production form submission and signed-in workspace access remain unverified.
No signup form was submitted and no credentials were altered.

The user's 2026-09-17 deployment request authorizes publishing the scoped login
follow-up under the existing emergency exception. G3/G10/G13 remain open and
the normal gated deploy command is unchanged. No D1 migrations, account
creation, password reset, or legal-acceptance operations are part of this release.

Reproduced and corrected in the shipped UI + SQLite diagnostic:

- Single-origin hosting selected Twenty's multi-domain auth-only router, which
  has no workspace routes. Single-origin workspace routing is now selected.
- Current-user queries containing field-metadata fragments were dispatched as
  metadata reads. Dispatch now uses the operation name at that boundary.
- Current-user fragment data needed GraphQL typenames, real membership-based
  workspace data, and valid identifiers. Virtual metadata/member identifiers
  are deterministic UUIDs; persisted record IDs are not rewritten.
- Workspace metadata needed the `objects.edges.node` connection shape. Exact
  bootstrap operations now return tenant-scoped D1 data after authorization.
- Signup accepted an 8-character password in the UI while the server required
  10. The signup UI now requires 10–50; existing login validation is unchanged.
- The client sends analytics on the welcome page even with analytics disabled.
  That exact operation now reports `success:false` without persisting data or
  weakening the authorization boundary for CRM operations.

Follow-up verification: **183 tests passed, 3 skipped**; TypeScript, module-graph
check, production security-configuration check, `git diff --check`, and Wrangler
dry-run passed. Six compiled-UI scenarios cover known/unknown email routing,
signup, login, restoring a session, and rejecting a short signup password.
Credential/session scenarios reach `/objects/activities` with the workspace
shell and no captured application errors or failed GraphQL responses.
Analytics now uses the real resolver rather than a test stub.

Limits: these are offline DOM/SQLite checks, not real browser/D1 credential
verification. They do not establish CRM CRUD, saved-view/filter/custom-object,
token-refresh, or complete workflow parity. Existing aggregate responses and
some token-exchange contracts still need broader mapping work. The compiled UI
falls back to English for the existing `es-VE` locale. No claim of a fully
functional CRM or completed migration is made by this emergency release.

## Reproduced defects

- The resolver's `/__schema|__type/` test matched Apollo's `__typename`.
  A real compiled `CheckUserExists` request to production `/metadata` returned
  `data.__schema` instead of `data.checkUserExists`. HTTP 200 was not success.
  A jsdom run of the shipped UI showed the same user-existence error toast.
- HTML loaded `index-D6X3OEUa.js?v=...`, but 197 chunk imports referenced the
  unqueried filename. This gave the entry (which also exports atoms and mounts
  React) two distinct module identities. The new module-graph check failed on
  this baseline and passes with a canonical entry URL.
- Client configuration made Twenty concatenate the worker name twice when
  determining its default login domain.
- Public workspace data returned a null `subdomainUrl`. Once GraphQL dispatch
  was fixed, the actual compiled domain redirect code threw `Invalid URL` in
  the local DOM diagnostic. Same-origin workspace URLs avoid that failure.

## Changes

- Match complete `__schema` / `__type` tokens, not the `__typename` prefix.
- Share the same main-module URL between HTML and all importing chunks.
- Apply no-store response headers to patched modules and navigation HTML.
- Generate a domain configuration that reconstructs the current hostname.
- Return valid same-origin workspace URLs for bootstrap, signup, and current user.
- Remove the HTML fetch monkeypatch that injected unrelated fake workspace
  fields into GraphQL results. Correct responses now come from the resolver.
- Preserve the existing Twenty stylesheet, components, and branding.
- Require a hashed, unexpired, email-matching invitation to join an existing
  workspace. Grant the invitation's member/admin role, never implicit owner.
  Recheck invitation validity inside the registration batch to reject revocation
  races and roll back registration. Only a newly created workspace grants owner.

## Verification

- [x] Red/green regression: email lookup with Apollo `__typename`, all four
  supported GraphQL paths. Protected queries still reach the auth boundary.
- [x] Offline compiled-UI tests: unknown email reaches Password + Sign up;
  existing email reaches Password + Login. Actual resolver, in-memory SQLite,
  shared client configuration. No network or production account writes.
- [x] SQLite-backed API tests: signup persistence, session cookie properties,
  current-user authorization, correct password, wrong password, cross-workspace denial.
- [x] Main module identity, workspace URL, and cache-policy tests.
- [x] TypeScript and Wrangler dry-run build.
- [x] Invitation checks: arbitrary workspace ID, wrong email/workspace,
  expired/revoked/consumed token, member role, and revocation-before-commit rollback.
- [x] Final local run: 176 tests passed, 3 skipped; typecheck and Worker dry-run passed.
- [ ] Real-browser end-to-end account creation/login/dashboard. The existing
  Chrome connection returned window titles but no usable AX tree or screenshot.
- [x] Initial production deployment and read-only post-deploy checks above.
- [x] Follow-up compiled-UI credential/session scenarios and deployment checks.
- [ ] Real-browser production credential submission / authenticated workspace.

`pnpm test` includes the compiled-UI subprocess test. It requires Node 22.13+
with `node:sqlite`, plus jsdom's supported Node version (tested on Node 26).
jsdom emulates DOM events; stylesheet loading is stubbed. These tests do NOT
verify browser layout, cookies across real navigations, or the full dashboard.

## Release blockers and remaining scope

`pnpm readiness:check` still exits 1: G3 and G10 partial, G13 blocked.
The standing project rule prohibits silently bypassing these gates. The explicit
exception above permits this repair's deployment while preserving their status.
The initial repair was deployed under that exception; no database migration was run.
`pnpm security:production:check` checks configuration and passed; it is NOT
an application security audit. Existing native workspace invitation/provisioning
authorization and the complete signed-in GraphQL contract still need review.
The pre-existing `SignUpInWorkspace` owner-grant flaw was discovered during
review and corrected in `workspace-signup.ts`. Invitation email delivery and
the full browser onboarding/dashboard flow remain outside the verification above.

The rollback guard follows [D1's documented batch transaction behavior](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch):
a failed statement rolls back the sequence. Its SQL behavior is tested with
SQLite locally; this repair has not been exercised against production D1.

`npm audit --omit=dev` reports zero production dependency vulnerabilities. The
development-tool dependency tree is tracked separately from this runtime repair.

The authentication-expiry and stale-route repair is deployed as Worker version
`54181337-b0e4-4dcc-a304-dfe5e54250d1`. A live unauthenticated protected query
returned HTTP 200 with `UNAUTHENTICATED`, `/client-config` returned
`enterpriseInstanceType: PRODUCTION`, the shipped bundle contains the hard
`/welcome` reset, and a live GET of `/not-found` returns a 302 to `/`. Do not call fresh credential submission
or every authenticated CRM workflow verified until a user signs in once with a
new seven-day session.
