import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { auditCutoverInputs } from '../scripts/check-postgres-cutover-inputs.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('accepts a complete, checksum-bound source, bundle, and attachment corpus', async () => {
  const root = mkdtempSync(join(tmpdir(), 'twenty-cutover-')); roots.push(root);
  const extract = join(root, 'extract'), bundle = join(root, 'bundle'), attachments = join(root, 'attachments');
  mkdirSync(extract); mkdirSync(bundle); mkdirSync(attachments);
  const workspaceId = '00000000-0000-4000-8000-000000000001';
  const source = '{"row":{"id":"one"}}\n';
  writeFileSync(join(extract, 'person.ndjson'), source);
  const manifest = { workspaceId, sourceReadOnly: true, completedAt: '2026-09-17T12:00:00.000Z', tables: [{ table: 'person', file: 'person.ndjson', rows: 1, sha256: createHash('sha256').update(source).digest('hex') }] };
  writeFileSync(join(extract, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(attachments, 'file-one'), 'data');
  writeFileSync(join(bundle, 'r2-required.json'), JSON.stringify([{ fileId: 'file-one', sourceLocator: 'file-one', bytes: 4 }]));
  writeFileSync(join(bundle, 'reconciliation.json'), JSON.stringify({ workspaceId, sourceManifestSha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') }));
  expect(await auditCutoverInputs({ extract, bundle, attachments })).toMatchObject({ ready: true, blockers: [] });
});

it('reports exact blockers instead of treating absent customer data as migrated', async () => {
  const report = await auditCutoverInputs({});
  expect(report.ready).toBe(false);
  expect(report.blockers).toContain('A PostgreSQL export directory is required.');
});
