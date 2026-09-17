import { parseWebhookEvent, verifyTwentyWebhookSignature } from "./lib";
import type { Env, WebhookMessage } from "./types";
import { enqueueOutboundWebhooks } from './outbound-webhooks';

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function triggerEventNames(trigger: unknown): string[] {
  const names = new Set<string>();
  const visit = (value: unknown, depth = 0) => {
    if (depth > 6 || value == null) return;
    if (typeof value === 'string') {
      if (/^[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*$/i.test(value)) names.add(value.toLowerCase());
      return;
    }
    if (Array.isArray(value)) { for (const entry of value.slice(0, 100)) visit(entry, depth + 1); return; }
    if (typeof value === 'object') for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (/^(eventName|event|events|recordEvent)$/i.test(key)) visit(entry, depth + 1);
      else if (/^(settings|config|type|name)$/i.test(key)) visit(entry, depth + 1);
    }
  };
  visit(trigger);
  return [...names];
}

async function deterministicRunId(eventId: string, workflowId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${eventId}:${workflowId}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export async function dispatchRecordTriggeredWorkflows(env: Env, eventId: string, payload: Record<string, unknown>): Promise<number> {
  if (!env.CRM_DB || !env.JOBS_QUEUE || typeof payload.workspaceId !== 'string') return 0;
  const action = String(payload.action ?? '').toLowerCase();
  const objectType = String(payload.objectType ?? '').toLowerCase();
  if (!action || !objectType) return 0;
  const eventName = `${objectType}.${action}`;
  const versions = await env.CRM_DB.prepare("SELECT v.id as versionId,v.workflow_id as workflowId,v.trigger_json as triggerJson,w.created_by as createdBy FROM native_workflow_versions v JOIN native_workflows w ON w.id=v.workflow_id AND w.workspace_id=v.workspace_id WHERE v.workspace_id=? AND v.status='ACTIVE' AND w.status='active'").bind(payload.workspaceId).all<{versionId:string;workflowId:string;triggerJson:string|null;createdBy:string}>();
  let queued = 0;
  for (const version of versions.results) {
    let trigger: unknown;
    try { trigger = version.triggerJson ? JSON.parse(version.triggerJson) : null; } catch { continue; }
    if (!triggerEventNames(trigger).includes(eventName)) continue;
    const runId = await deterministicRunId(eventId, version.workflowId);
    const now = new Date().toISOString();
    const inserted = await env.CRM_DB.prepare("INSERT OR IGNORE INTO native_workflow_runs (id,workflow_id,workspace_id,status,input_json,created_by,created_at,updated_at) VALUES (?,?,?,'queued',?,?,?,?)")
      .bind(runId, version.workflowId, payload.workspaceId, JSON.stringify({ trigger: { eventId, eventName, workflowVersionId: version.versionId }, record: payload }), String(payload.actorSubject ?? version.createdBy), now, now).run();
    if (Number(inserted.meta?.changes ?? 0) !== 1) continue;
    try {
      await env.JOBS_QUEUE.send({ schemaVersion: 1, id: runId, queueName: 'twenty-jobs', jobName: 'workflow.run', data: { runId, workflowId: version.workflowId, workspaceId: payload.workspaceId, actorSubject: String(payload.actorSubject ?? version.createdBy) }, createdAt: now, retryLimit: 3, priority: 0 });
      queued += 1;
    } catch (error) {
      await env.CRM_DB.prepare("UPDATE native_workflow_runs SET status='failed',error=?,updated_at=? WHERE id=? AND workspace_id=?").bind(`queue unavailable: ${String(error).slice(0, 300)}`, new Date().toISOString(), runId, payload.workspaceId).run();
      throw error;
    }
  }
  return queued;
}

/**
 * Twenty webhook → CF Queue producer. Configure in Twenty:
 * Settings → API & Webhooks → target URL:
 *   https://twenty-crm.rikitrader.workers.dev/webhooks/twenty
 * Twenty signs `${timestamp}:${rawBody}` with HMAC SHA-256.  WEBHOOK_TOKEN is
 * the server-side HMAC secret and is never accepted in a URL or bearer header.
 */
export async function handleWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST")
    return new Response("method not allowed", { status: 405 });
  const declaredLength=Number(request.headers.get('content-length')??0);
  if(!Number.isFinite(declaredLength)||declaredLength<0||declaredLength>100_000)return new Response('payload too large',{status:413});
  const raw=await request.text();
  const timestamp=request.headers.get('x-twenty-webhook-timestamp');
  const signature=request.headers.get('x-twenty-webhook-signature');
  if(!(await verifyTwentyWebhookSignature(raw,timestamp,signature,env.WEBHOOK_TOKEN)))return new Response('invalid webhook signature',{status:401});
  const parsed = parseWebhookEvent(raw);
  if (!parsed) return new Response("malformed payload", { status: 400 });
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`${timestamp}:${raw}`));
  const eventId=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  await env.EVENTS_QUEUE.send({
    eventId,
    type: parsed.type,
    payload: parsed.payload,
    receivedAt: new Date().toISOString(),
  });
  return new Response("queued", {
    status: 202,headers:{'cache-control':'no-store'},
  });
}

/** Queue consumer → D1 events table. Per-message retry; DLQ after max retries. */
export async function consumeBatch(
  batch: MessageBatch<WebhookMessage>,
  env: Env,
): Promise<void> {
  const stmt = env.OPS_DB.prepare(
    "INSERT OR IGNORE INTO events (event_id, type, payload, received_at) VALUES (?, ?, ?, ?)",
  );
  for (const msg of batch.messages) {
    try {
      await stmt
        .bind(msg.body.eventId || msg.id, msg.body.type, msg.body.payload, msg.body.receivedAt)
        .run();
      const payload = object(JSON.parse(msg.body.payload));
      if (env.PUBSUB_DO) {
        if (typeof payload.workspaceId === 'string') {
          const stub = env.PUBSUB_DO.get(env.PUBSUB_DO.idFromName(payload.workspaceId));
          await stub.publish(`workspace:${payload.workspaceId}`, payload);
        }
      }
      await dispatchRecordTriggeredWorkflows(env, msg.body.eventId || msg.id, payload);
      await enqueueOutboundWebhooks(env,msg.body.eventId||msg.id,msg.body.type,payload);
      msg.ack();
    } catch (e) {
      console.log("event insert failed, retrying:", e);
      msg.retry();
    }
  }
}
