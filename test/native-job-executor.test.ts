import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { executeNativeJob } from '../src/native-job-executor';
import { compatibilityId } from '../src/compatibility-id';
import type { CloudflareTwentyJob, Env } from '../src/types';

let db: DatabaseSync;
let env: Env;
const workspaceId = 'workflow-workspace';
const workflowId = 'workflow-one';
const runId = 'workflow-run-one';
const now = '2026-09-17T12:00:00.000Z';

beforeEach(() => {
  db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const prepare = (sql: string) => ({ bind(...values: unknown[]) { const statement = db.prepare(sql); return { first: async () => statement.get(...values as never[]) ?? null, all: async () => ({ results: statement.all(...values as never[]) }), run: async () => ({ success: true, meta: statement.run(...values as never[]) }) }; } });
  env = { CRM_DB: { prepare } } as unknown as Env;
  db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run(workspaceId, 'Workflow workspace', now);
});
afterEach(() => db.close());

const job = (): CloudflareTwentyJob => ({ schemaVersion: 1, id: runId, queueName: 'twenty-jobs', jobName: 'workflow.run', data: { runId, workflowId, workspaceId, actorSubject: 'user:owner' }, createdAt: now, retryLimit: 3, priority: 0 });

it('executes supported record steps natively and makes duplicate delivery idempotent', async () => {
  const definition = { steps: [
    { id: 'company', type: 'create_record', config: { objectType: 'company', values: { name: '{{input.companyName}}' } } },
    { id: 'note', type: 'create_note', config: { objectType: 'activity', title: 'Created {{steps.company.id}}', body: 'Cloudflare native' } },
  ] };
  db.prepare('INSERT INTO native_workflows VALUES (?,?,?,?,?,?,?,?,?)').run(workflowId, workspaceId, 'Native workflow', null, 'active', JSON.stringify(definition), 'user:owner', now, now);
  db.prepare('INSERT INTO native_workflow_runs VALUES (?,?,?,?,?,?,?,?,?,?)').run(runId, workflowId, workspaceId, 'queued', JSON.stringify({ companyName: 'D1 Company' }), null, null, 'user:owner', now, now);
  expect((await executeNativeJob(job(), env)).status).toBe(204);
  expect(db.prepare('SELECT status FROM native_workflow_runs WHERE id=?').get(runId)).toMatchObject({ status: 'completed' });
  expect(db.prepare('SELECT name FROM companies WHERE workspace_id=?').all(workspaceId)).toEqual([{ name: 'D1 Company' }]);
  expect(db.prepare('SELECT type,title FROM activities WHERE workspace_id=?').all(workspaceId)).toEqual([{ type: 'note', title: `Created ${runId}-company` }]);
  expect(db.prepare('SELECT COUNT(*) AS count FROM native_workflow_run_steps WHERE run_id=? AND status=\'completed\'').get(runId)).toMatchObject({ count: 2 });
  expect((await executeNativeJob(job(), env)).status).toBe(204);
  expect(db.prepare('SELECT COUNT(*) AS count FROM companies WHERE workspace_id=?').get(workspaceId)).toMatchObject({ count: 1 });
  expect(db.prepare('SELECT COUNT(*) AS count FROM activities WHERE workspace_id=?').get(workspaceId)).toMatchObject({ count: 1 });
});

it('executes Workers AI chat jobs idempotently and publishes the response', async () => {
  const threadId='thread-one';const messageId='message-one';
  db.prepare('INSERT INTO ai_chat_threads VALUES (?,?,?,?,?,?,?)').run(threadId,workspaceId,'Chat','active','user:owner',now,now);
  db.prepare("INSERT INTO ai_chat_messages VALUES (?,?,?,?,?,?)").run(messageId,threadId,workspaceId,'user','Summarize this CRM',now);
  let runs=0;const events:unknown[]=[];
  env.AI={run:async()=>{runs+=1;return{response:'Your CRM is ready.'};}} as never;
  env.PUBSUB_DO={idFromName:(name:string)=>name,get:()=>({publish:async(_channel:string,payload:unknown)=>{events.push(payload);return 1;}})} as never;
  const aiJob={...job(),id:messageId,jobName:'ai.chat',data:{workspaceId,threadId,messageId,actorSubject:'user:owner'}};
  expect((await executeNativeJob(aiJob,env)).status).toBe(204);
  expect(db.prepare("SELECT role,content FROM ai_chat_messages WHERE id=?").get(await compatibilityId(`ai-assistant:${workspaceId}:${threadId}:${messageId}`))).toEqual({role:'assistant',content:'Your CRM is ready.'});
  expect(events).toHaveLength(1);
  expect((await executeNativeJob(aiJob,env)).status).toBe(204);
  expect(runs).toBe(1);
});

it('retries instead of claiming success when the AI binding is absent', async () => {
  const threadId='thread-two';const messageId='message-two';
  db.prepare('INSERT INTO ai_chat_threads VALUES (?,?,?,?,?,?,?)').run(threadId,workspaceId,'Chat','active','user:owner',now,now);
  db.prepare("INSERT INTO ai_chat_messages VALUES (?,?,?,?,?,?)").run(messageId,threadId,workspaceId,'user','Hello',now);
  expect((await executeNativeJob({...job(),id:messageId,jobName:'ai.chat',data:{workspaceId,threadId,messageId}},env)).status).toBe(503);
});
