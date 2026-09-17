import { CronExpressionParser } from 'cron-parser';
import type { Env } from './types';

function cronExpression(trigger: unknown, depth = 0): string | null {
  if (depth > 6 || trigger == null) return null;
  if (typeof trigger === 'string') return /^(@(?:hourly|daily|weekly|monthly)|(?:\S+\s+){4,5}\S+)$/.test(trigger.trim()) ? trigger.trim() : null;
  if (Array.isArray(trigger)) for (const entry of trigger.slice(0, 50)) { const found = cronExpression(entry, depth + 1); if (found) return found; }
  if (typeof trigger === 'object') for (const [key, value] of Object.entries(trigger as Record<string, unknown>)) {
    if (/^(cron|cronExpression|schedule|pattern)$/i.test(key)) { const found = cronExpression(value, depth + 1); if (found) return found; }
    if (/^(settings|config|trigger)$/i.test(key)) { const found = cronExpression(value, depth + 1); if (found) return found; }
  }
  return null;
}

async function runId(workflowId: string, minute: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`schedule:${workflowId}:${minute}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export async function dispatchScheduledWorkflows(env: Env, scheduledTime: number): Promise<{ queued: number; invalid: number }> {
  if (!env.CRM_DB || !env.JOBS_QUEUE) return { queued: 0, invalid: 0 };
  const versions = await env.CRM_DB.prepare("SELECT v.id as versionId,v.workflow_id as workflowId,v.workspace_id as workspaceId,v.trigger_json as triggerJson,w.created_by as createdBy FROM native_workflow_versions v JOIN native_workflows w ON w.id=v.workflow_id AND w.workspace_id=v.workspace_id WHERE v.status='ACTIVE' AND w.status='active'").bind().all<{versionId:string;workflowId:string;workspaceId:string;triggerJson:string|null;createdBy:string}>();
  const minute = Math.floor(scheduledTime / 60_000) * 60_000;
  let queued = 0; let invalid = 0;
  for (const version of versions.results) {
    let expression: string | null = null;
    try { expression = cronExpression(version.triggerJson ? JSON.parse(version.triggerJson) : null); } catch { invalid += 1; continue; }
    if (!expression) continue;
    try {
      const previous = CronExpressionParser.parse(expression, { currentDate: new Date(minute + 59_999), tz: 'UTC' }).prev().getTime();
      if (previous < minute || previous >= minute + 60_000) continue;
    } catch { invalid += 1; continue; }
    const id = await runId(version.workflowId, minute); const now = new Date(scheduledTime).toISOString();
    const inserted = await env.CRM_DB.prepare("INSERT OR IGNORE INTO native_workflow_runs (id,workflow_id,workspace_id,status,input_json,created_by,created_at,updated_at) VALUES (?,?,?,'queued',?,?,?,?)")
      .bind(id, version.workflowId, version.workspaceId, JSON.stringify({ trigger: { type: 'schedule', scheduledTime: minute, workflowVersionId: version.versionId } }), version.createdBy, now, now).run();
    if (Number(inserted.meta?.changes ?? 0) !== 1) continue;
    try {
      await env.JOBS_QUEUE.send({ schemaVersion: 1, id, queueName: 'twenty-jobs', jobName: 'workflow.run', data: { runId: id, workflowId: version.workflowId, workspaceId: version.workspaceId, actorSubject: version.createdBy }, createdAt: now, retryLimit: 3, priority: 0 });
      queued += 1;
    } catch (error) {
      await env.CRM_DB.prepare("UPDATE native_workflow_runs SET status='failed',error=?,updated_at=? WHERE id=? AND workspace_id=?").bind(`queue unavailable: ${String(error).slice(0, 300)}`, new Date().toISOString(), id, version.workspaceId).run();
      throw error;
    }
  }
  return { queued, invalid };
}
