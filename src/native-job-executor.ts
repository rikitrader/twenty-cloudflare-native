import type { CloudflareTwentyJob, Env } from './types';
import { compatibilityId } from './compatibility-id';
import { executeWebhookDelivery } from './outbound-webhooks';
import { executeEmailDelivery } from './crm-email';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Step = { id: string; type: string; config?: Record<string, unknown> };
type JobData = { runId?: string; workflowId?: string; workspaceId?: string; actorSubject?: string };
type AiJobData = { workspaceId?: string; threadId?: string; messageId?: string; actorSubject?: string };

const TABLES: Record<string, { table: string; fields: Record<string, string>; required: string[] }> = {
  person: { table: 'contacts', fields: { firstName: 'first_name', lastName: 'last_name', email: 'email' }, required: ['firstName', 'lastName'] },
  people: { table: 'contacts', fields: { firstName: 'first_name', lastName: 'last_name', email: 'email' }, required: ['firstName', 'lastName'] },
  company: { table: 'companies', fields: { name: 'name', domain: 'domain' }, required: ['name'] },
  companies: { table: 'companies', fields: { name: 'name', domain: 'domain' }, required: ['name'] },
  opportunity: { table: 'opportunities', fields: { name: 'name', stage: 'stage', amountCents: 'amount_cents', companyId: 'company_id', pointOfContactId: 'point_of_contact_id', pipelineId: 'pipeline_id' }, required: ['name'] },
  activity: { table: 'activities', fields: { type: 'type', title: 'title', body: 'body', contactId: 'contact_id', companyId: 'company_id', opportunityId: 'opportunity_id', dueAt: 'due_at' }, required: ['title'] },
};

function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function resolvePath(source: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => object(value)[key], source);
}
function resolveValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{\s*([^}]+)\s*\}\}$/);
    if (exact) return resolvePath(context, exact[1].trim());
    return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_all, path: string) => String(resolvePath(context, path.trim()) ?? ''));
  }
  if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, resolveValue(entry, context)]));
  return value;
}

async function runRecordStep(env: Env, workspaceId: string, runId: string, step: Step, context: Record<string, unknown>): Promise<Record<string, unknown>> {
  const config = resolveValue(step.config ?? {}, context) as Record<string, unknown>;
  const entity = TABLES[String(config.objectType ?? '').toLowerCase()];
  if (!entity) throw new Error(`Unsupported object type for ${step.id}`);
  const values = object(config.values);
  if (step.type === 'create_record' || step.type === 'create_task' || step.type === 'create_note') {
    if (step.type === 'create_task') { values.type = 'task'; values.title ??= config.title; values.body ??= config.body; }
    if (step.type === 'create_note') { values.type = 'note'; values.title ??= config.title ?? 'Workflow note'; values.body ??= config.body; }
    for (const required of entity.required) if (typeof values[required] !== 'string' || !String(values[required]).trim()) throw new Error(`${required} is required for ${step.id}`);
    const id = `${runId}-${step.id}`.slice(0, 128); const now = new Date().toISOString();
    const entries = Object.entries(values).filter(([key, value]) => entity.fields[key] && value !== undefined);
    const columns = ['id', 'workspace_id', ...entries.map(([key]) => entity.fields[key]), 'created_at', 'updated_at'];
    const params = [id, workspaceId, ...entries.map(([, value]) => value), now, now];
    await env.CRM_DB!.prepare(`INSERT OR IGNORE INTO ${entity.table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).bind(...params).run();
    return { id, objectType: String(config.objectType), created: true };
  }
  if (step.type === 'update_record') {
    const id = String(config.recordId ?? ''); if (!id) throw new Error(`recordId is required for ${step.id}`);
    const entries = Object.entries(values).filter(([key, value]) => entity.fields[key] && value !== undefined);
    if (!entries.length) return { id, updated: false };
    const result = await env.CRM_DB!.prepare(`UPDATE ${entity.table} SET ${entries.map(([key]) => `${entity.fields[key]} = ?`).join(',')},updated_at = ? WHERE workspace_id = ? AND id = ? AND deleted_at IS NULL`).bind(...entries.map(([, value]) => value), new Date().toISOString(), workspaceId, id).run();
    if (Number(result.meta?.changes ?? 0) !== 1) throw new Error(`Record not found for ${step.id}`);
    return { id, objectType: String(config.objectType), updated: true };
  }
  throw new Error(`Unsupported workflow step type ${step.type}`);
}

async function executeWorkflow(job: CloudflareTwentyJob, env: Env): Promise<Response> {
  const data = object(job.data) as JobData; const runId = String(data.runId ?? job.id); const workspaceId = String(data.workspaceId ?? '');
  if (!workspaceId || !runId) return new Response('invalid workflow job', { status: 409 });
  const run = await env.CRM_DB!.prepare('SELECT r.status,r.input_json as inputJson,w.definition_json as definition FROM native_workflow_runs r JOIN native_workflows w ON w.id=r.workflow_id AND w.workspace_id=r.workspace_id WHERE r.id=? AND r.workspace_id=?').bind(runId, workspaceId).first<{status:string;inputJson:string;definition:string}>();
  if (!run) return new Response('workflow run not found', { status: 409 });
  if (run.status === 'completed' || run.status === 'cancelled') return new Response(null, { status: 204 });
  let definition: Record<string, unknown>; let input: Record<string, unknown>;
  try { definition = object(JSON.parse(run.definition)); input = object(JSON.parse(run.inputJson)); } catch { return new Response('invalid workflow definition', { status: 409 }); }
  const steps = Array.isArray(definition.steps) ? definition.steps.filter((value): value is Step => Boolean(value && typeof value === 'object' && typeof (value as Step).id === 'string' && typeof (value as Step).type === 'string')) : [];
  const now = new Date().toISOString(); await env.CRM_DB!.prepare("UPDATE native_workflow_runs SET status='running',error=NULL,updated_at=? WHERE id=? AND workspace_id=? AND status IN ('queued','failed')").bind(now, runId, workspaceId).run();
  const outputs: Record<string, unknown> = {};
  try {
    for (const step of steps) {
      const previous = await env.CRM_DB!.prepare("SELECT status,output_json as output FROM native_workflow_run_steps WHERE run_id=? AND step_id=? AND workspace_id=?").bind(runId, step.id, workspaceId).first<{status:string;output:string|null}>();
      if (previous?.status === 'completed') { outputs[step.id] = previous.output ? JSON.parse(previous.output) : {}; continue; }
      const startedAt = new Date().toISOString();
      await env.CRM_DB!.prepare("INSERT INTO native_workflow_run_steps (run_id,step_id,workspace_id,status,started_at) VALUES (?,?,?,'running',?) ON CONFLICT(run_id,step_id) DO UPDATE SET status='running',error=NULL,started_at=excluded.started_at").bind(runId, step.id, workspaceId, startedAt).run();
      const output = await runRecordStep(env, workspaceId, runId, step, { input, steps: outputs }); outputs[step.id] = output;
      await env.CRM_DB!.prepare("UPDATE native_workflow_run_steps SET status='completed',output_json=?,completed_at=? WHERE run_id=? AND step_id=? AND workspace_id=?").bind(JSON.stringify(output), new Date().toISOString(), runId, step.id, workspaceId).run();
    }
    await env.CRM_DB!.prepare("UPDATE native_workflow_runs SET status='completed',output_json=?,error=NULL,updated_at=? WHERE id=? AND workspace_id=?").bind(JSON.stringify({ steps: outputs }), new Date().toISOString(), runId, workspaceId).run();
    return new Response(null, { status: 204 });
  } catch (error) {
    await env.CRM_DB!.prepare("UPDATE native_workflow_runs SET status='failed',error=?,updated_at=? WHERE id=? AND workspace_id=?").bind(String(error).slice(0, 500), new Date().toISOString(), runId, workspaceId).run();
    return new Response('workflow execution failed', { status: 409 });
  }
}

async function executeAiChat(job: CloudflareTwentyJob, env: Env): Promise<Response> {
  const data = object(job.data) as AiJobData;
  const workspaceId = String(data.workspaceId ?? '');
  const threadId = String(data.threadId ?? '');
  const messageId = String(data.messageId ?? job.id);
  if (!workspaceId || !threadId || !messageId) return new Response('invalid AI chat job', { status: 409 });
  if (!env.AI) return new Response('Workers AI binding unavailable', { status: 503, headers: { 'x-twenty-execution-outcome': 'not-started' } });
  const assistantId = await compatibilityId(`ai-assistant:${workspaceId}:${threadId}:${messageId}`);
  const existing = await env.CRM_DB!.prepare('SELECT id FROM ai_chat_messages WHERE id=? AND workspace_id=? AND thread_id=?').bind(assistantId, workspaceId, threadId).first();
  if (existing) return new Response(null, { status: 204 });
  const thread = await env.CRM_DB!.prepare("SELECT id FROM ai_chat_threads WHERE id=? AND workspace_id=? AND status='active'").bind(threadId, workspaceId).first();
  if (!thread) return new Response('AI chat thread not found', { status: 409 });
  const history = await env.CRM_DB!.prepare("SELECT role,content FROM ai_chat_messages WHERE workspace_id=? AND thread_id=? AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 30").bind(workspaceId, threadId).all<{role:string;content:string}>();
  if (!history.results.some((entry) => entry.role === 'user')) return new Response('AI chat prompt not found', { status: 409 });
  const messages = [...history.results].reverse().map((entry) => ({ role: entry.role, content: entry.content }));
  const model = env.AI_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast';
  const output = await env.AI.run(model as Parameters<Ai['run']>[0], { messages, max_tokens: 1024 } as never) as unknown;
  const content = typeof output === 'string' ? output : String(object(output).response ?? object(output).result ?? '').trim();
  if (!content) return new Response('AI provider returned an empty response', { status: 502 });
  const now = new Date().toISOString();
  await env.CRM_DB!.prepare("INSERT OR IGNORE INTO ai_chat_messages (id,thread_id,workspace_id,role,content,created_at) VALUES (?,?,?,'assistant',?,?)").bind(assistantId, threadId, workspaceId, content.slice(0, 100_000), now).run();
  await env.CRM_DB!.prepare('UPDATE ai_chat_threads SET updated_at=? WHERE id=? AND workspace_id=?').bind(now, threadId, workspaceId).run();
  if (env.PUBSUB_DO) {
    const stub = env.PUBSUB_DO.get(env.PUBSUB_DO.idFromName(workspaceId)) as unknown as { publish(channel:string,payload:unknown):Promise<number> };
    await stub.publish(`workspace:${workspaceId}`, { eventId: assistantId, type: 'ai.chat.message', threadId, messageId: assistantId, role: 'assistant', content, createdAt: now });
  }
  return new Response(null, { status: 204 });
}

export async function executeNativeJob(job: CloudflareTwentyJob, env: Env): Promise<Response> {
  if (!env.CRM_DB) return new Response('CRM database unavailable', { status: 503, headers: { 'x-twenty-execution-outcome': 'not-started' } });
  if (job.jobName === 'workflow.run') return executeWorkflow(job, env);
  if (job.jobName === 'ai.chat') return executeAiChat(job, env);
  if (job.jobName === 'webhook.deliver') return executeWebhookDelivery(job, env);
  if (job.jobName === 'email.send') return executeEmailDelivery(job, env);
  return new Response(`unsupported native job: ${job.jobName}`, { status: 409 });
}
