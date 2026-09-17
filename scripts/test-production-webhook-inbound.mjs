import { createHmac, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const endpoint = process.argv[2];
const mode = process.argv[3] ?? 'twenty';
if (!endpoint) {
  console.error('usage: node scripts/test-production-webhook-inbound.mjs <endpoint>');
  process.exit(2);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const [line] = await Array.fromAsync(lines);
const { secret, workspaceId } = JSON.parse(line ?? '{}');

if (typeof secret !== 'string' || secret.length < 32 || typeof workspaceId !== 'string') {
  console.error('stdin must contain one JSON line with secret and workspaceId');
  process.exit(2);
}

const timestamp = String(Date.now());
const eventId = randomUUID();
const body = mode === 'receiver'
  ? JSON.stringify({ id:eventId, event:'webhook.self-test', workspaceId, data:{ workspaceId, action:'test', objectType:'webhook' } })
  : JSON.stringify({ type:'crm.webhook.integration-test', payload:{ workspaceId, eventId, action:'test', objectType:'webhook' } });
const signature = createHmac('sha256', secret).update(`${timestamp}:${body}`).digest('hex');
const response = await fetch(endpoint, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-twenty-webhook-timestamp': timestamp,
    'x-twenty-webhook-signature': signature,
  },
  body,
});

console.log(JSON.stringify({ eventId, status: response.status, body: await response.text() }));
if (response.status !== 202) process.exit(1);
