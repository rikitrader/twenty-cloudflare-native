#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const sha256File = async (path) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};

const lineCount = async (path) => {
  let count = 0;
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) if (line.trim()) count += 1;
  return count;
};

export async function auditCutoverInputs({ extract, bundle, attachments }) {
  const result = { ready: false, checks: [], blockers: [] };
  const check = (name, passed, detail) => { result.checks.push({ name, passed, detail }); if (!passed) result.blockers.push(detail); };
  if (!extract) {
    check('postgres-export', false, 'A PostgreSQL export directory is required.');
    return result;
  }
  const root = resolve(extract);
  const manifestPath = join(root, 'manifest.json');
  check('manifest-present', existsSync(manifestPath), 'manifest.json is missing from the PostgreSQL export.');
  if (!existsSync(manifestPath)) return result;
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { check('manifest-json', false, 'manifest.json is not valid JSON.'); return result; }
  check('workspace-id', typeof manifest.workspaceId === 'string' && /^[0-9a-f-]{36}$/i.test(manifest.workspaceId), 'The source manifest has no valid workspace UUID.');
  check('read-only-source', manifest.sourceReadOnly === true, 'The source manifest does not prove a read-only extraction.');
  check('completed-export', typeof manifest.completedAt === 'string' && Array.isArray(manifest.tables) && manifest.tables.length > 0, 'The PostgreSQL extraction is incomplete.');
  for (const table of Array.isArray(manifest.tables) ? manifest.tables : []) {
    const path = join(root, String(table.file ?? ''));
    if (!existsSync(path)) { check(`table:${table.table}`, false, `Missing source table artifact ${String(table.file ?? table.table)}.`); continue; }
    const checksum = await sha256File(path);
    check(`checksum:${table.table}`, checksum === table.sha256, `Checksum mismatch for ${basename(path)}.`);
    const rows = await lineCount(path);
    check(`rows:${table.table}`, rows === Number(table.rows), `Row count mismatch for ${basename(path)}.`);
  }
  if (!bundle) {
    check('reconciled-bundle', false, 'A reconciled import bundle is required.');
    return result;
  }
  const bundleRoot = resolve(bundle);
  const reconciliationPath = join(bundleRoot, 'reconciliation.json');
  const requiredPath = join(bundleRoot, 'r2-required.json');
  check('reconciliation-present', existsSync(reconciliationPath), 'reconciliation.json is missing from the import bundle.');
  check('r2-manifest-present', existsSync(requiredPath), 'r2-required.json is missing from the import bundle.');
  if (!existsSync(reconciliationPath) || !existsSync(requiredPath)) return result;
  const reconciliation = JSON.parse(readFileSync(reconciliationPath, 'utf8'));
  check('workspace-match', reconciliation.workspaceId === manifest.workspaceId, 'Export and import-bundle workspace IDs do not match.');
  const sourceHash = createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
  check('source-manifest-hash', reconciliation.sourceManifestSha256 === sourceHash, 'The reconciled bundle does not match the supplied source manifest.');
  const required = JSON.parse(readFileSync(requiredPath, 'utf8'));
  if (!Array.isArray(required)) { check('r2-manifest-json', false, 'r2-required.json must be an array.'); return result; }
  if (required.length && !attachments) check('attachment-root', false, `${required.length} attachment binaries are required, but no attachment directory was provided.`);
  if (attachments) {
    const filesRoot = resolve(attachments);
    for (const item of required) {
      const candidates = [join(filesRoot, String(item.fileId)), join(filesRoot, basename(String(item.sourceLocator ?? '')))];
      const path = candidates.find(existsSync);
      if (!path) { check(`attachment:${item.fileId}`, false, `Attachment binary is missing for ${item.fileId}.`); continue; }
      const bytes = statSync(path).size;
      check(`attachment-bytes:${item.fileId}`, !Number(item.bytes) || bytes === Number(item.bytes), `Attachment byte count mismatch for ${item.fileId}.`);
    }
  }
  result.ready = result.blockers.length === 0;
  return result;
}

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const item = process.argv[index];
  if (!item.startsWith('--')) continue;
  const next = process.argv[index + 1];
  args.set(item.slice(2), !next || next.startsWith('--') ? true : process.argv[++index]);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await auditCutoverInputs({ extract: args.get('extract'), bundle: args.get('bundle'), attachments: args.get('attachments') });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 2;
}
