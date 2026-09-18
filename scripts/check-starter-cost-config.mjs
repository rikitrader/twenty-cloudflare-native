import { readFile } from 'node:fs/promises';

const files = ['wrangler.jsonc', 'wrangler.example.jsonc'];

function stripJsonComments(input) {
  let out = '', quoted = false, escaped = false, line = false, block = false;
  for (let index = 0; index < input.length; index += 1) {
    const current = input[index], next = input[index + 1];
    if (line) { if (current === '\n') { line = false; out += current; } continue; }
    if (block) { if (current === '*' && next === '/') { block = false; index += 1; } continue; }
    if (quoted) {
      out += current;
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === '"') quoted = false;
      continue;
    }
    if (current === '"') { quoted = true; out += current; }
    else if (current === '/' && next === '/') { line = true; index += 1; }
    else if (current === '/' && next === '*') { block = true; index += 1; }
    else out += current;
  }
  return out;
}

const errors = [];
const warnings = [];
const requireValue = (condition, message) => { if (!condition) errors.push(message); };

for (const file of files) {
  const config = JSON.parse(stripJsonComments(await readFile(file, 'utf8')));
  const bindings = values => new Set((values ?? []).map(value => value.binding));
  const d1 = bindings(config.d1_databases);
  const r2 = bindings(config.r2_buckets);
  const kv = bindings(config.kv_namespaces);
  const queueProducers = bindings(config.queues?.producers);
  const workflows = bindings(config.workflows);
  const durableObjects = bindings(config.durable_objects?.bindings?.map(value => ({ binding: value.name })));

  requireValue(!('containers' in config), `${file}: Containers must not be a runtime dependency`);
  requireValue(!('hyperdrive' in config), `${file}: Hyperdrive/external SQL must not be a runtime dependency`);
  requireValue(config.vars?.REDIS_BACKEND === 'cloudflare', `${file}: Redis replacement must remain Cloudflare-native`);
  requireValue(d1.has('CRM_DB') && d1.has('OPS_DB') && d1.size === 2, `${file}: exactly CRM_DB and OPS_DB D1 bindings are required`);
  requireValue(r2.has('STORAGE') && r2.size === 1, `${file}: exactly one tenant file/backup R2 binding is required`);
  requireValue(kv.has('STATUS_KV'), `${file}: STATUS_KV must remain a disposable status cache`);
  requireValue(['EVENTS_QUEUE', 'JOBS_QUEUE', 'JOBS_DLQ'].every(value => queueProducers.has(value)), `${file}: event, job, and DLQ producers are required`);
  requireValue(['BACKUP_WF', 'CRM_EXPORT_WF', 'CRM_IMPORT_WF'].every(value => workflows.has(value)), `${file}: backup, export, and import Workflows are required`);
  requireValue(['STATE_DO', 'SCHEDULER_DO', 'PUBSUB_DO'].every(value => durableObjects.has(value)), `${file}: state, scheduler, and pubsub Durable Objects are required`);
  requireValue(config.assets?.binding === 'ASSETS' && config.assets?.run_worker_first === true, `${file}: Workers Static Assets must remain behind the Worker authorization boundary`);
  requireValue(config.observability?.enabled === true && config.observability?.redact_query_string === true, `${file}: persisted observability and query-string redaction are required`);
  requireValue(Array.isArray(config.triggers?.crons) && config.triggers.crons.length > 0, `${file}: scheduled maintenance and continuity triggers are required`);
}

const result = {
  checkedAt: new Date().toISOString(),
  profile: 'cloudflare-native-starter',
  result: errors.length === 0 ? 'passed' : 'failed',
  errors,
  warnings,
};
console.log(JSON.stringify(result, null, 2));
if (errors.length > 0) process.exitCode = 1;
