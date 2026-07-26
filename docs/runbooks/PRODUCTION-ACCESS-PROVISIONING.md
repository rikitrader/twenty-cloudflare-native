# Production Access and perimeter provisioning

This is the external change required before `cutover:production` can pass.
Wrangler does not manage Zero Trust Access applications, WAF rules, or
Logpush jobs, so these controls must be provisioned in the Cloudflare Zero
Trust/dashboard or via the account security API by an authorized owner.

## Required production objects

1. Access application for the production hostname and `/_ops/*` path, with a
   unique audience (never reuse the canary audience).
2. Organization IdP policy requiring phishing-resistant MFA for operators.
3. Separate service-auth policy/token for monitoring and automation.
4. Group-based operator policy; no single-email production allow rule.
5. Managed WAF rules and route-specific rate limiting on the production custom
   domain.
6. Access authentication, Worker, and mutation audit Logpush jobs to immutable
   SIEM/R2 retention.

## Values to place in `wrangler.jsonc`

```jsonc
"ACCESS_REQUIRED": "true",
"ACCESS_TEAM_DOMAIN": "https://<organization>.cloudflareaccess.com",
"ACCESS_AUD": "<unique-production-access-audience>",
"REDIS_BACKEND": "cloudflare"
```

Credentials remain Worker secrets. Never put `OPS_TOKEN`,
`INTERNAL_SERVICE_TOKEN`, database URLs, or Access service secrets in `vars`.
After provisioning, run:

```sh
npm run security:production:check
npm run readiness:check
CUTOVER_APPROVAL=CUTOVER_APPROVAL_REQUIRED npm run cutover:production
```

The cutover command snapshots and automatically rolls back on failed health
validation; it does not bypass any gate.
