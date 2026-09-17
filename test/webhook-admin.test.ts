import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { handleWebhookAdminApi, webhookAdminPage } from '../src/webhook-admin';
import type { CloudflareTwentyJob, Env } from '../src/types';

let db: DatabaseSync;
let env: Env;
const workspace = 'workspace-one';
const otherWorkspace = 'workspace-two';
const now = '2026-09-17T12:00:00.000Z';
const token = `twenty_${'a'.repeat(32)}`;
const memberToken = `twenty_${'b'.repeat(32)}`;
const jobs: CloudflareTwentyJob[] = [];

async function digest(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

const request = (path: string, accessToken = token, init: RequestInit = {}) => new Request(`https://twenty.example.test${path}`, {
  ...init,
  headers: { authorization: `Bearer ${accessToken}`, 'x-workspace-id': workspace, ...(init.headers ?? {}) },
});

beforeEach(async () => {
  jobs.length = 0;
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const prepare = (sql: string) => ({ bind(...values: unknown[]) { const statement = db.prepare(sql); return { first: async () => statement.get(...values as never[]) ?? null, all: async () => ({ results: statement.all(...values as never[]) }), run: async () => ({ success: true, meta: statement.run(...values as never[]) }) }; } });
  env = { ACCESS_REQUIRED: 'true', CRM_DB: { prepare }, JOBS_QUEUE: { send: async (job: CloudflareTwentyJob) => { jobs.push(job); } } } as unknown as Env;
  db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run(workspace, 'One', now);
  db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run(otherWorkspace, 'Two', now);
  db.prepare('INSERT INTO native_api_keys (id,workspace_id,name,token_hash,role,created_at) VALUES (?,?,?,?,?,?)').run('admin-key', workspace, 'Admin', await digest(token), 'admin', now);
  db.prepare('INSERT INTO native_api_keys (id,workspace_id,name,token_hash,role,created_at) VALUES (?,?,?,?,?,?)').run('member-key', workspace, 'Member', await digest(memberToken), 'member', now);
  db.prepare('INSERT INTO native_webhooks (id,workspace_id,name,url,events_json,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('hook-one', workspace, 'Primary hook', 'https://hooks.example.test/twenty', '["crm.create"]', 1, now, now);
  db.prepare('INSERT INTO native_webhooks (id,workspace_id,name,url,events_json,active,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('hook-two', otherWorkspace, 'Other hook', 'https://hooks.example.test/twenty', '["crm.create"]', 1, now, now);
  db.prepare("INSERT INTO webhook_deliveries (id,webhook_id,workspace_id,event_id,event_type,status,payload_json,last_error,created_at,updated_at) VALUES ('failed-delivery','hook-one',?,'event-one','crm.create','failed',?,'timeout',?,?)").run(workspace, JSON.stringify({ workspaceId: workspace, objectId: 'person-one' }), now, now);
  db.prepare("INSERT INTO webhook_deliveries (id,webhook_id,workspace_id,event_id,event_type,status,payload_json,last_error,created_at,updated_at) VALUES ('other-delivery','hook-two',?,'event-two','crm.create','failed',?,'timeout',?,?)").run(otherWorkspace, JSON.stringify({ workspaceId: otherWorkspace }), now, now);
});

afterEach(() => db.close());

it('lists only tenant-scoped deliveries for an administrator', async () => {
  const response = await handleWebhookAdminApi(request('/api/admin/webhook-deliveries?status=failed'), env);
  expect(response?.status).toBe(200);
  const body = await response!.json() as {data:Array<{id:string;replayable:boolean}>;page:{total:number}};
  expect(body.data).toEqual([expect.objectContaining({ id: 'failed-delivery', replayable: true })]);
  expect(body.page.total).toBe(1);
});

it('atomically queues a retained-payload replay and records an audit event', async () => {
  const response = await handleWebhookAdminApi(request('/api/admin/webhook-deliveries/failed-delivery/replay', token, { method: 'POST', headers: { origin: 'https://twenty.example.test', 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) }), env);
  expect(response?.status).toBe(202);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ jobName: 'webhook.deliver', data: { deliveryId: 'failed-delivery', workspaceId: workspace }, retainDedupe: true });
  expect(jobs[0].id).not.toBe('failed-delivery');
  expect(db.prepare('SELECT status,replay_count,last_error,replayed_by FROM webhook_deliveries WHERE id=?').get('failed-delivery')).toEqual({ status: 'queued', replay_count: 1, last_error: null, replayed_by: 'api-key:admin-key' });
  expect(db.prepare("SELECT action,object_type,object_id FROM crm_audit_events WHERE object_id='failed-delivery'").get()).toEqual({ action: 'replay', object_type: 'webhook_delivery', object_id: 'failed-delivery' });
});

it('requires explicit confirmation, rejects non-admins, and never crosses tenants', async () => {
  expect((await handleWebhookAdminApi(request('/api/admin/webhook-deliveries/failed-delivery/replay', token, { method: 'POST', body: '{}' }), env))?.status).toBe(400);
  expect((await handleWebhookAdminApi(request('/api/admin/webhook-deliveries', memberToken), env))?.status).toBe(403);
  expect((await handleWebhookAdminApi(request('/api/admin/webhook-deliveries/other-delivery/replay', token, { method: 'POST', body: JSON.stringify({ confirm: true }) }), env))?.status).toBe(404);
  expect(jobs).toHaveLength(0);
});

it('fails closed when a historical delivery has no recoverable payload', async () => {
  db.prepare("UPDATE webhook_deliveries SET payload_json=NULL WHERE id='failed-delivery'").run();
  const response = await handleWebhookAdminApi(request('/api/admin/webhook-deliveries/failed-delivery/replay', token, { method: 'POST', body: JSON.stringify({ confirm: true }) }), env);
  expect(response?.status).toBe(409);
  expect(jobs).toHaveLength(0);
  expect(db.prepare("SELECT status FROM webhook_deliveries WHERE id='failed-delivery'").get()).toEqual({ status: 'failed' });
});

it('serves a CSP-protected authenticated admin interface', async () => {
  const response = await webhookAdminPage(request('/_ops/webhooks'), env);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
  const html = await response.text();
  expect(html).toContain('Webhook delivery history');
  expect(html).toContain('Legacy deliveries created before payload retention cannot be replayed.');
  expect(html).toContain('Payload unavailable');
  expect(html).toContain('href="/settings/profile"');
});
