import type { Env } from './types';

export type MutationLedger = {
  eventId: string;
  payload: Record<string, unknown>;
  statements: D1PreparedStatement[];
};

export function mutationLedger(env: Env, workspaceId: string, actor: string, action: string, objectType: string, objectId: string, metadata: Record<string, unknown> = {}): MutationLedger {
  const eventId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const now = new Date().toISOString();
  const payload = { eventId, workspaceId, actorSubject: actor, requestId, action, objectType, objectId, occurredAt: now };
  return {
    eventId,
    payload,
    statements: [
      env.CRM_DB!.prepare('INSERT INTO crm_audit_events (id,workspace_id,actor_subject,action,object_type,object_id,request_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .bind(crypto.randomUUID(), workspaceId, actor, action, objectType, objectId, requestId, JSON.stringify(metadata), now),
      env.CRM_DB!.prepare("INSERT INTO crm_event_outbox (event_id,workspace_id,actor_subject,action,object_type,object_id,payload_json,status,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'pending',0,?,?)")
        .bind(eventId, workspaceId, actor, action, objectType, objectId, JSON.stringify(payload), now, now),
    ],
  };
}

export async function dispatchMutationLedger(env: Env, ledger: MutationLedger): Promise<void> {
  if (!env.EVENTS_QUEUE) return;
  try {
    const now = new Date().toISOString();
    await env.EVENTS_QUEUE.send({ eventId: ledger.eventId, type: `crm.${ledger.payload.action}`, payload: JSON.stringify(ledger.payload), receivedAt: now });
    await env.CRM_DB!.prepare("UPDATE crm_event_outbox SET status='queued',attempts=attempts+1,last_error=NULL,updated_at=? WHERE event_id=? AND status IN ('pending','failed')").bind(now, ledger.eventId).run();
  } catch (error) {
    await env.CRM_DB!.prepare("UPDATE crm_event_outbox SET status='failed',attempts=attempts+1,last_error=?,updated_at=? WHERE event_id=? AND status IN ('pending','failed')").bind(String(error).slice(0, 500), new Date().toISOString(), ledger.eventId).run();
  }
}

type OutboxRow = { event_id: string; action: string; payload_json: string };

/** Retry durable CRM events. Sending is intentionally at-least-once; the queue
 * consumer's unique event_id makes repeated delivery harmless. */
export async function drainMutationOutbox(env: Env, limit = 100): Promise<{ queued: number; failed: number }> {
  if (!env.CRM_DB || !env.EVENTS_QUEUE) return { queued: 0, failed: 0 };
  const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
  const rows = await env.CRM_DB.prepare("SELECT event_id,action,payload_json FROM crm_event_outbox WHERE status IN ('pending','failed') AND attempts < 10 ORDER BY created_at LIMIT ?")
    .bind(boundedLimit).all<OutboxRow>();
  let queued = 0;
  let failed = 0;
  for (const row of rows.results) {
    const now = new Date().toISOString();
    try {
      await env.EVENTS_QUEUE.send({ eventId: row.event_id, type: `crm.${row.action}`, payload: row.payload_json, receivedAt: now });
      await env.CRM_DB.prepare("UPDATE crm_event_outbox SET status='queued',attempts=attempts+1,last_error=NULL,updated_at=? WHERE event_id=? AND status IN ('pending','failed')")
        .bind(now, row.event_id).run();
      queued += 1;
    } catch (error) {
      await env.CRM_DB.prepare("UPDATE crm_event_outbox SET status='failed',attempts=attempts+1,last_error=?,updated_at=? WHERE event_id=? AND status IN ('pending','failed')")
        .bind(String(error).slice(0, 500), now, row.event_id).run();
      failed += 1;
    }
  }
  return { queued, failed };
}
