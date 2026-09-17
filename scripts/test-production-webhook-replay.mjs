#!/usr/bin/env node
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const endpoint = String(process.env.TWENTY_ENDPOINT ?? 'https://twenty-crm.observatorio-publico.workers.dev').replace(/\/$/, '');
const clean = value => String(value).replace(/\u001b\[[0-9;]*m/g, '');
const quote = value => `'${String(value).replaceAll("'", "''")}'`;

function d1(sql) {
  const result = spawnSync('./node_modules/.bin/wrangler', ['d1', 'execute', 'CRM_DB', '--remote', '--json', '--command', sql], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`D1 command failed: ${clean(result.stderr || result.stdout).slice(0, 1000)}`);
  const output = clean(result.stdout);
  const start = output.indexOf('[');
  if (start < 0) throw new Error('D1 command did not return JSON');
  return JSON.parse(output.slice(start))[0]?.results ?? [];
}

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const hook = d1("SELECT id,workspace_id as workspaceId FROM native_webhooks WHERE active=1 AND events_json LIKE '%webhook.self-test%' ORDER BY updated_at DESC LIMIT 1")[0];
if (!hook?.id || !hook.workspaceId) throw new Error('No active production self-test webhook is registered');

const apiKeyId = `replay-test-${randomUUID()}`;
const token = `twenty_${randomBytes(32).toString('hex')}`;
const tokenHash = createHash('sha256').update(token).digest('hex');
const deliveryId = `replay-test-${randomUUID()}`;
const eventId = `replay-event-${randomUUID()}`;
const now = new Date().toISOString();
const payload = JSON.stringify({ workspaceId: hook.workspaceId, action: 'production-replay-test', objectType: 'webhook', objectId: eventId });

try {
  d1(`INSERT INTO native_api_keys (id,workspace_id,name,token_hash,role,created_at) VALUES (${quote(apiKeyId)},${quote(hook.workspaceId)},'Production replay verification',${quote(tokenHash)},'admin',${quote(now)}); INSERT INTO webhook_deliveries (id,webhook_id,workspace_id,event_id,event_type,status,payload_json,last_error,created_at,updated_at) VALUES (${quote(deliveryId)},${quote(hook.id)},${quote(hook.workspaceId)},${quote(eventId)},'webhook.self-test','failed',${quote(payload)},'controlled production verification',${quote(now)},${quote(now)});`);
  const response = await fetch(`${endpoint}/api/admin/webhook-deliveries/${deliveryId}/replay`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-workspace-id': hook.workspaceId, origin: endpoint }, body: JSON.stringify({ confirm: true }) });
  if (response.status !== 202) throw new Error(`Replay API returned ${response.status}: ${(await response.text()).slice(0, 500)}`);
  let delivery;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    delivery = d1(`SELECT status,attempts,replay_count as replayCount,response_status as responseStatus,last_error as lastError FROM webhook_deliveries WHERE id=${quote(deliveryId)} AND workspace_id=${quote(hook.workspaceId)}`)[0];
    if (delivery?.status === 'delivered' || delivery?.status === 'dead') break;
    await wait(1_000);
  }
  const receipt = d1(`SELECT COUNT(*) as count FROM webhook_receiver_events WHERE event_id=${quote(eventId)} AND workspace_id=${quote(hook.workspaceId)}`)[0];
  if (delivery?.status !== 'delivered' || Number(delivery.replayCount) !== 1 || Number(delivery.attempts) !== 1 || Number(receipt?.count) !== 1) throw new Error(`Replay verification failed: ${JSON.stringify({ delivery, receiptCount: receipt?.count ?? 0 })}`);
  console.log(JSON.stringify({ result: 'passed', deliveryId, eventId, status: delivery.status, attempts: delivery.attempts, replayCount: delivery.replayCount, responseStatus: delivery.responseStatus, receiverReceipts: receipt.count }, null, 2));
} finally {
  d1(`DELETE FROM webhook_receiver_events WHERE event_id=${quote(eventId)} AND workspace_id=${quote(hook.workspaceId)}; DELETE FROM webhook_deliveries WHERE id=${quote(deliveryId)} AND workspace_id=${quote(hook.workspaceId)}; DELETE FROM native_api_keys WHERE id=${quote(apiKeyId)} AND workspace_id=${quote(hook.workspaceId)};`);
}
