# Contributing

Thank you for improving the Cloudflare-native Twenty CRM edition.

## Before opening a pull request

1. Open or reference an issue for changes that alter public contracts,
   migrations, permissions, infrastructure, or upstream Twenty behavior.
2. Keep changes tenant-safe and deny access by default.
3. Never commit credentials, customer data, exports, attachments, `.env`, or
   `.dev.vars` files.
4. Preserve Twenty's upstream license headers and attribution.
5. Update documentation and `docs/FULL-PARITY-TODO.md` without claiming
   verification that was not performed.

## Development checks

```bash
npm ci
npm run patch:twenty
npm run typecheck
npm test
npm run db:migrations:check
npm run audit:mutations
npm run security:production:check
gitleaks git --config .gitleaks.toml --redact .
```

Maintainers updating against a new upstream Twenty checkout can regenerate the
committed operation inventory with `TWENTY_UPSTREAM=/path/to/twenty npm run
audit:operations:update`. Normal contributors and CI verify that inventory
without requiring a separate upstream repository.

Add focused tests for authorization failures, cross-tenant access, duplicate
delivery, retries, partial provider failures, and schema changes whenever they
apply. Use disposable workspaces and synthetic data for browser tests.

## Pull requests

- Keep commits reviewable and explain behavior changes and rollback impact.
- List migrations, new bindings, secret names, provider callbacks, and cost
  implications.
- Include evidence for tests actually run.
- Do not bypass readiness or security gates to make CI green.
- Avoid destructive production operations in pull requests.

By contributing, you agree that your contribution is provided under the
licenses applicable to the files you modify.
