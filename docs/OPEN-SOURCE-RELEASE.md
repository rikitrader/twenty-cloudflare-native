# Open-source publication record

Published: 2026-09-18

Repository: <https://github.com/rikitrader/twenty-cloudflare-native>

## GitHub metadata

- Visibility: public
- Template repository: enabled
- Homepage: <https://crm.mipolitico.com>
- Description: Open-source Cloudflare-native Twenty CRM using Workers, D1,
  R2, Queues, Workflows, Durable Objects, KV, AI, Email, authentication,
  webhooks, imports, and exports without PostgreSQL, Redis, Containers, or an
  external application host.
- Topics: `cloudflare`, `cloudflare-workers`, `d1`, `r2`, `queues`,
  `workflows`, `durable-objects`, `workers-ai`, `twenty-crm`, `crm`,
  `typescript`, `serverless`, `graphql`, `multitenant`, `open-source`, and the
  retained legacy `workers` topic.
- Issues and Discussions: enabled
- Wiki: disabled; versioned documentation remains in Git
- Merge policy: squash and rebase enabled, merge commits disabled, merged
  branches deleted

## Community and reuse assets

- Expanded architecture, feature, setup, verification, status, and licensing
  documentation in `README.md`.
- Portable, syntactically validated `wrangler.example.jsonc` for new accounts.
- `docs/SELF-HOSTING.md` with resource, secret, migration, deployment, and
  post-deployment requirements.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue forms, and pull
  request template.
- Dependabot configuration for npm and GitHub Actions.
- Current Cloudflare-native verification and manual deployment workflows;
  stale Container-based release steps were removed.

The package remains `private: true` only to prevent accidental publication to
the npm registry. It does not restrict cloning, forking, deployment, or use of
the GitHub repository.

## Security publication gate

- Full Git history scanned: 160 commits and approximately 54.69 MB.
- Current working tree scanned: approximately 108.82 MB.
- Result: no credential leaks after narrow false-positive rules for public
  Worker version IDs, Cloudflare Access audiences, and compiled Twenty state
  keys.
- GitHub Secret Scanning: enabled.
- GitHub Push Protection: enabled.
- Private vulnerability reporting: enabled.
- Dependabot vulnerability alerts and automated security fixes: enabled.
- First public `Secret scan` workflow: passed.

The repository excludes deployment credentials, customer records, database
exports, attachment payloads, `.env`, `.dev.vars`, private keys, and local
artifacts.

## License

This derivative preserves the upstream `LICENSE` and `NOTICE.md`. GitHub may
display the composite license as “Other” because the file includes AGPLv3,
Twenty's additional application exception, package-specific MIT terms, and
marked commercial-file terms. The repository must not be simplistically
relicensed as MIT while it contains modified Twenty code and compiled assets.

Users may use, modify, self-host, and redistribute the project subject to the
license applicable to each file. Network deployment of modified AGPL-covered
code can require offering corresponding source to users.

## Truthful readiness status

Public availability does not mean final production-readiness certification or
complete upstream feature parity. The open evidence gates in
`docs/FULL-PARITY-TODO.md` remain authoritative. The reference deployment's
seven-day observation, production-browser, WAF, and Logpush evidence remain
open and are not represented as complete.
