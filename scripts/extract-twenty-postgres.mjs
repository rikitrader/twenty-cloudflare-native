#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SENSITIVE_COLUMN = /(password|secret|token|credential|private.?key|refresh.?token|access.?token)/i;

export const parseArgs = (argv) => {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const next = argv[index + 1];
    args.set(item.slice(2), !next || next.startsWith('--') ? true : argv[++index]);
  }
  return args;
};

const identifier = (value) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`unsafe PostgreSQL identifier: ${value}`);
  return `"${value.replaceAll('"', '""')}"`;
};

const jsonValue = (_key, value) => {
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return { $binaryBase64: value.toString('base64') };
  return value;
};

const atomicJson = (path, value) => {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, jsonValue, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
};

const tableFileName = (scope, schema, table) => `${scope}--${schema}--${table}.ndjson`;

async function catalog(client, schema) {
  const { rows } = await client.query(
    `SELECT t.table_name,
            COALESCE(json_agg(c.column_name ORDER BY c.ordinal_position)
              FILTER (WHERE c.column_name IS NOT NULL), '[]') AS columns
       FROM information_schema.tables t
       LEFT JOIN information_schema.columns c
         ON c.table_schema=t.table_schema AND c.table_name=t.table_name
      WHERE t.table_schema=$1 AND t.table_type='BASE TABLE'
      GROUP BY t.table_name ORDER BY t.table_name`,
    [schema],
  );
  return rows.map((row) => ({ table: row.table_name, columns: row.columns }));
}

async function workspaceCoreTables(client) {
  const { rows } = await client.query(
    `SELECT DISTINCT table_name
       FROM information_schema.columns
      WHERE table_schema='core' AND column_name='workspaceId'
      ORDER BY table_name`,
  );
  return rows.map((row) => row.table_name);
}

function checkpoint(output, baseline) {
  const path = join(output, 'extract-state.json');
  if (!existsSync(path)) return { path, state: { ...baseline, completedTables: {} } };
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (state.workspaceId !== baseline.workspaceId || state.databaseFingerprint !== baseline.databaseFingerprint) {
    throw new Error('checkpoint belongs to a different workspace or PostgreSQL source');
  }
  return { path, state };
}

async function exportTable({ client, output, scope, schema, table, columns, workspaceId, batchSize, includeSensitive, state, statePath }) {
  const omittedColumns = includeSensitive ? [] : columns.filter((column) => SENSITIVE_COLUMN.test(column));
  const selected = columns.filter((column) => !omittedColumns.includes(column));
  if (!selected.length) return { scope, schema, table, rows: 0, sha256: createHash('sha256').digest('hex'), omittedColumns };
  const target = join(output, tableFileName(scope, schema, table));
  const temporary = `${target}.partial`;
  const stream = createWriteStream(temporary, { flags: 'w', mode: 0o600 });
  const hash = createHash('sha256');
  let offset = 0;
  let count = 0;
  const where = scope === 'core' && table !== 'workspace' ? ` WHERE "workspaceId"=$1` : scope === 'core' ? ' WHERE "id"=$1' : '';
  const params = where ? [workspaceId] : [];
  while (true) {
    const sql = `SELECT ${selected.map(identifier).join(',')} FROM ${identifier(schema)}.${identifier(table)}${where} ORDER BY 1 LIMIT ${batchSize} OFFSET ${offset}`;
    const result = await client.query(sql, params);
    if (!result.rows.length) break;
    for (const row of result.rows) {
      const line = `${JSON.stringify({ scope, schema, table, row }, jsonValue)}\n`;
      hash.update(line);
      if (!stream.write(line)) await new Promise((done) => stream.once('drain', done));
      count += 1;
    }
    offset += result.rows.length;
    state.current = { scope, schema, table, offset };
    atomicJson(statePath, state);
  }
  await new Promise((done, reject) => stream.end((error) => error ? reject(error) : done()));
  renameSync(temporary, target);
  const entry = { scope, schema, table, rows: count, sha256: hash.digest('hex'), file: basename(target), omittedColumns };
  state.completedTables[`${scope}.${schema}.${table}`] = entry;
  delete state.current;
  atomicJson(statePath, state);
  return entry;
}

export async function extractPostgres({ client, workspaceId, output, batchSize = 1_000, includeSensitive = false, dryRun = false }) {
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) throw new Error('--workspace-id must be a UUID');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new Error('--batch-size must be between 1 and 10000');
  const resolvedOutput = resolve(output);
  mkdirSync(resolvedOutput, { recursive: true, mode: 0o700 });
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const workspace = await client.query('SELECT "id", "databaseSchema", "createdAt", "updatedAt" FROM core."workspace" WHERE "id"=$1', [workspaceId]);
    if (workspace.rowCount !== 1) throw new Error('workspace does not exist in core.workspace');
    const schema = workspace.rows[0].databaseSchema;
    if (!schema || !/^workspace_[A-Za-z0-9_]+$/.test(schema)) throw new Error('workspace has no valid databaseSchema');
    const identity = await client.query('SELECT current_database() AS database, current_setting(\'server_version\') AS version');
    const databaseFingerprint = createHash('sha256').update(`${identity.rows[0].database}:${schema}`).digest('hex');
    const coreNames = new Set(['workspace', ...(await workspaceCoreTables(client))]);
    const coreCatalog = (await catalog(client, 'core')).filter(({ table }) => coreNames.has(table));
    const workspaceCatalog = await catalog(client, schema);
    const plan = [
      ...coreCatalog.map((entry) => ({ scope: 'core', schema: 'core', ...entry })),
      ...workspaceCatalog.map((entry) => ({ scope: 'workspace', schema, ...entry })),
    ];
    const baseline = { version: 1, workspaceId, workspaceSchema: schema, databaseFingerprint, startedAt: new Date().toISOString(), sourceReadOnly: true, includeSensitive };
    if (dryRun) {
      await client.query('ROLLBACK');
      return { ...baseline, dryRun: true, tables: plan.map(({ scope, schema: tableSchema, table, columns }) => ({ scope, schema: tableSchema, table, columns: columns.length })) };
    }
    const { path: statePath, state } = checkpoint(resolvedOutput, baseline);
    const tables = [];
    for (const entry of plan) {
      const key = `${entry.scope}.${entry.schema}.${entry.table}`;
      if (state.completedTables[key]) {
        tables.push(state.completedTables[key]);
        continue;
      }
      tables.push(await exportTable({ client, output: resolvedOutput, workspaceId, batchSize, includeSensitive, state, statePath, ...entry }));
    }
    const manifest = { ...baseline, completedAt: new Date().toISOString(), tables, totals: { tables: tables.length, rows: tables.reduce((sum, table) => sum + table.rows, 0) } };
    atomicJson(join(resolvedOutput, 'manifest.json'), manifest);
    state.completed = true;
    state.completedAt = manifest.completedAt;
    atomicJson(statePath, state);
    await client.query('COMMIT');
    return manifest;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = String(args.get('database-url') ?? process.env.TWENTY_POSTGRES_URL ?? '');
  const workspaceId = String(args.get('workspace-id') ?? '');
  const output = String(args.get('output') ?? 'twenty-postgres-export');
  if (!databaseUrl) throw new Error('--database-url or TWENTY_POSTGRES_URL is required');
  if (!workspaceId) throw new Error('--workspace-id is required');
  const { Client } = await import('pg');
  const client = new Client({ connectionString: databaseUrl, application_name: 'twenty-cloudflare-readonly-extractor' });
  await client.connect();
  try {
    const result = await extractPostgres({ client, workspaceId, output, batchSize: Number(args.get('batch-size') ?? 1_000), includeSensitive: args.has('include-sensitive'), dryRun: args.has('dry-run') });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(`PostgreSQL extraction failed: ${error.message}`); process.exitCode = 1; });
