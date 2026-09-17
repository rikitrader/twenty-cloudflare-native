import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { drainMutationOutbox } from '../src/crm-mutation-ledger';
import { consumeBatch } from '../src/queue';
import { dispatchScheduledWorkflows } from '../src/workflow-triggers';
import type { Env, WebhookMessage } from '../src/types';

let db: DatabaseSync;
let database: D1Database;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  const prepare = (sql: string) => ({ bind(...values: unknown[]) {
    const statement = db.prepare(sql);
    return {
      first: async () => statement.get(...values as never[]) ?? null,
      all: async () => ({ results: statement.all(...values as never[]) }),
      run: async () => ({ success: true, meta: statement.run(...values as never[]) }),
    };
  } });
  database = { prepare } as unknown as D1Database;
});

afterEach(() => db.close());

it('retries failed outbox sends and marks the durable event queued', async () => {
  const now = '2026-09-17T12:00:00.000Z';
  db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run('ws-1', 'Outbox test', now);
  db.prepare("INSERT INTO crm_event_outbox (event_id,workspace_id,actor_subject,action,object_type,object_id,payload_json,status,attempts,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'failed',1,?,?)")
    .run('event-1', 'ws-1', 'user-1', 'create', 'task', 'task-1', '{"eventId":"event-1"}', now, now);
  const send = vi.fn().mockResolvedValue(undefined);
  const result = await drainMutationOutbox({ CRM_DB: database, EVENTS_QUEUE: { send } } as unknown as Env);
  expect(result).toEqual({ queued: 1, failed: 0 });
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'event-1', type: 'crm.create' }));
  expect(db.prepare('SELECT status,attempts,last_error FROM crm_event_outbox WHERE event_id=?').get('event-1')).toMatchObject({ status: 'queued', attempts: 2, last_error: null });
});

it('deduplicates repeated queue delivery by stable event id', async () => {
  const message = (ack: ReturnType<typeof vi.fn>) => ({
    id: crypto.randomUUID(),
    body: { eventId: 'event-duplicate', type: 'crm.create', payload: '{}', receivedAt: '2026-09-17T12:00:00.000Z' } satisfies WebhookMessage,
    ack,
    retry: vi.fn(),
  });
  const firstAck = vi.fn();
  const secondAck = vi.fn();
  await consumeBatch({ queue: 'twenty-events', messages: [message(firstAck), message(secondAck)] } as unknown as MessageBatch<WebhookMessage>, { OPS_DB: database } as unknown as Env);
  expect(db.prepare('SELECT COUNT(*) AS count FROM events WHERE event_id=?').get('event-duplicate')).toMatchObject({ count: 1 });
  expect(firstAck).toHaveBeenCalledOnce();
  expect(secondAck).toHaveBeenCalledOnce();
});

it('creates one workflow run for a matching committed record event and never double-enqueues it', async () => {
  const now = '2026-09-17T12:00:00.000Z';
  db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run('ws-trigger', 'Trigger test', now);
  db.prepare("INSERT INTO native_workflows (id,workspace_id,name,status,definition_json,created_by,created_at,updated_at) VALUES (?,?,?,'active',?,?,?,?)")
    .run('workflow-1', 'ws-trigger', 'Task created', '{"steps":[]}', 'owner', now, now);
  db.prepare("INSERT INTO native_workflow_versions (id,workflow_id,workspace_id,version,status,trigger_json,steps_json,edges_json,created_by,created_at,updated_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run('version-1', 'workflow-1', 'ws-trigger', 1, 'ACTIVE', '{"type":"DATABASE_EVENT","settings":{"eventName":"task.create"}}', '[]', '[]', 'owner', now, now, now);
  const send = vi.fn().mockResolvedValue(undefined);
  const message = () => ({
    id: crypto.randomUUID(),
    body: { eventId: 'workflow-event-1', type: 'crm.create', payload: JSON.stringify({ eventId: 'workflow-event-1', workspaceId: 'ws-trigger', actorSubject: 'owner', action: 'create', objectType: 'task', objectId: 'task-1' }), receivedAt: now } satisfies WebhookMessage,
    ack: vi.fn(), retry: vi.fn(),
  });
  const first = message(); const duplicate = message();
  const environment = { OPS_DB: database, CRM_DB: database, JOBS_QUEUE: { send } } as unknown as Env;
  await consumeBatch({ queue: 'twenty-events', messages: [first] } as unknown as MessageBatch<WebhookMessage>, environment);
  await consumeBatch({ queue: 'twenty-events', messages: [duplicate] } as unknown as MessageBatch<WebhookMessage>, environment);
  expect(send).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ jobName: 'workflow.run', data: expect.objectContaining({ workflowId: 'workflow-1', workspaceId: 'ws-trigger' }) }));
  expect(db.prepare('SELECT COUNT(*) AS count FROM native_workflow_runs').get()).toMatchObject({ count: 1 });
  expect(first.ack).toHaveBeenCalledOnce();
  expect(duplicate.ack).toHaveBeenCalledOnce();
});

it('creates one scheduled run per workflow/minute and ignores duplicate cron delivery', async () => {
  const scheduledTime = Date.parse('2026-09-17T12:10:00.000Z'); const now = new Date(scheduledTime).toISOString();
  db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run('ws-cron', 'Cron test', now);
  db.prepare("INSERT INTO native_workflows (id,workspace_id,name,status,definition_json,created_by,created_at,updated_at) VALUES (?,?,?,'active',?,?,?,?)")
    .run('workflow-cron', 'ws-cron', 'Every five minutes', '{"steps":[]}', 'owner', now, now);
  db.prepare("INSERT INTO native_workflow_versions (id,workflow_id,workspace_id,version,status,trigger_json,steps_json,edges_json,created_by,created_at,updated_at,published_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run('version-cron', 'workflow-cron', 'ws-cron', 1, 'ACTIVE', '{"type":"CRON","settings":{"cronExpression":"*/5 * * * *"}}', '[]', '[]', 'owner', now, now, now);
  const send = vi.fn().mockResolvedValue(undefined);
  const environment = { CRM_DB: database, JOBS_QUEUE: { send } } as unknown as Env;
  expect(await dispatchScheduledWorkflows(environment, scheduledTime)).toEqual({ queued: 1, invalid: 0 });
  expect(await dispatchScheduledWorkflows(environment, scheduledTime + 20_000)).toEqual({ queued: 0, invalid: 0 });
  expect(send).toHaveBeenCalledOnce();
  expect(db.prepare('SELECT COUNT(*) AS count FROM native_workflow_runs WHERE workspace_id=?').get('ws-cron')).toMatchObject({ count: 1 });
});
