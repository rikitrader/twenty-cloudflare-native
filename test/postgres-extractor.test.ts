import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { extractPostgres } from '../scripts/extract-twenty-postgres.mjs';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fakeClient() {
  const calls: { text: string; values?: unknown[] }[] = [];
  const query = async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    if (text.startsWith('BEGIN') || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
    if (text.includes('FROM core."workspace"')) return { rows: [{ id: values?.[0], databaseSchema: 'workspace_abc', createdAt: new Date(), updatedAt: new Date() }], rowCount: 1 };
    if (text.includes('current_database')) return { rows: [{ database: 'twenty', version: '16' }], rowCount: 1 };
    if (text.includes("column_name='workspaceId'")) return { rows: [{ table_name: 'userWorkspace' }], rowCount: 1 };
    if (text.includes("t.table_schema=$1") && values?.[0] === 'core') return { rows: [
      { table_name: 'workspace', columns: ['id', 'databaseSchema', 'apiToken'] },
      { table_name: 'userWorkspace', columns: ['id', 'workspaceId', 'userId'] },
    ], rowCount: 2 };
    if (text.includes("t.table_schema=$1") && values?.[0] === 'workspace_abc') return { rows: [{ table_name: 'person', columns: ['id', 'nameFirstName', 'createdAt'] }], rowCount: 1 };
    if (/ OFFSET (?!0\b)\d+/.test(text)) return { rows: [], rowCount: 0 };
    if (text.includes('FROM "core"."workspace"')) return { rows: [{ id: 'workspace-id', databaseSchema: 'workspace_abc' }], rowCount: 1 };
    if (text.includes('FROM "core"."userWorkspace"')) return { rows: [{ id: 'membership', workspaceId: values?.[0], userId: 'user' }], rowCount: 1 };
    if (text.includes('FROM "workspace_abc"."person"')) return { rows: [{ id: 'person', nameFirstName: 'Ada', createdAt: new Date('2026-01-01') }], rowCount: 1 };
    throw new Error(`unexpected query: ${text}`);
  };
  return { query, calls };
}

it('exports a read-only deterministic manifest and omits sensitive columns by default', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'twenty-pg-'));
  directories.push(directory);
  const client = fakeClient();
  const result = await extractPostgres({ client, workspaceId: '00000000-0000-4000-8000-000000000001', output: directory, batchSize: 100 });
  expect(client.calls[0].text).toContain('READ ONLY');
  expect(result.totals).toEqual({ tables: 3, rows: 3 });
  expect(result.tables.find((table: any) => table.table === 'workspace')?.omittedColumns).toEqual(['apiToken']);
  expect(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')).sourceReadOnly).toBe(true);
  expect(readFileSync(join(directory, 'workspace--workspace_abc--person.ndjson'), 'utf8')).toContain('Ada');
});

it('dry-run catalogs source data without creating record files', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'twenty-pg-dry-'));
  directories.push(directory);
  const client = fakeClient();
  const result = await extractPostgres({ client, workspaceId: '00000000-0000-4000-8000-000000000001', output: directory, dryRun: true });
  expect(result.dryRun).toBe(true);
  expect(client.calls.at(-1)?.text).toBe('ROLLBACK');
});
