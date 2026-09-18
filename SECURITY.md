# Security policy

## Reporting a vulnerability

Do not disclose vulnerabilities, credentials, tenant data, or exploit details
in a public issue or discussion. Use GitHub's private vulnerability reporting
for this repository. If that channel is unavailable, contact the repository
owner privately through the verified contact method on the GitHub profile.

Include the affected commit or deployed version, reproduction conditions,
impact, tenant boundary involved, and a safe proof of concept. Remove secrets
and personal data from reports.

## Supported versions

Security fixes target the current `main` branch and the currently documented
production Worker version. Historical commits and forks are not automatically
patched.

## Security expectations

- Authentication, tenant membership, permissions, and ownership are enforced
  server-side.
- Unknown operations and unconfigured providers fail closed.
- Secrets belong in Cloudflare Secrets or an equivalent protected store.
- Webhooks require signature validation and replay protection.
- Queue messages may be delivered more than once and must remain idempotent.
- R2 access requires tenant and object ownership checks.

Publishing this repository does not publish access to the reference Cloudflare
account, databases, buckets, providers, or production secrets.
