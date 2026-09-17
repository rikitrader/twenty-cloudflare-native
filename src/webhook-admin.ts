import { accessIdentityForRequest, type AccessIdentity } from './access';
import { compatibilityId } from './compatibility-id';
import { nativeSessionToken } from './native-auth';
import type { CloudflareTwentyJob, Env } from './types';

const VALID_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REPLAYABLE = new Set(['failed', 'dead']);
const STATUSES = new Set(['queued', 'delivering', 'delivered', 'failed', 'dead']);

type AdminContext = { actor: AccessIdentity; workspaceId: string; role: string };

const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { 'cache-control': 'private, no-store' },
});

async function adminContext(request: Request, env: Env): Promise<AdminContext | Response> {
  if (!env.CRM_DB) return json({ error: 'CRM_DB is not configured' }, 503);
  const actor = await accessIdentityForRequest(request, env);
  if (!actor) return json({ error: 'unauthorized' }, 401);
  const url = new URL(request.url);
  const requested = request.headers.get('x-workspace-id') ?? url.searchParams.get('workspaceId');
  if (requested && !VALID_ID.test(requested)) return json({ error: 'invalid workspaceId' }, 400);
  if (actor.authenticationType === 'api-key') {
    const workspaceId = requested ?? actor.workspaceId ?? '';
    if (!workspaceId || workspaceId !== actor.workspaceId || !['owner', 'admin'].includes(actor.workspaceRole ?? '')) return json({ error: 'admin access required' }, 403);
    return { actor, workspaceId, role: actor.workspaceRole! };
  }
  let workspaceId = requested ?? '';
  if (!workspaceId && actor.authenticationType === 'native-session') {
    const token = nativeSessionToken(request);
    if (token) workspaceId = String((await env.CRM_DB.prepare("SELECT workspace_id as workspaceId FROM native_sessions WHERE id=? AND identity_subject=? AND revoked_at IS NULL AND expires_at>? LIMIT 1").bind(token, actor.subject, new Date().toISOString()).first<{workspaceId:string}>())?.workspaceId ?? '');
  }
  const membership = workspaceId
    ? await env.CRM_DB.prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND identity_subject=? AND status='active' LIMIT 1").bind(workspaceId, actor.subject).first<{role:string}>()
    : await env.CRM_DB.prepare("SELECT workspace_id as workspaceId,role FROM workspace_members WHERE identity_subject=? AND status='active' AND role IN ('owner','admin') ORDER BY created_at LIMIT 1").bind(actor.subject).first<{workspaceId:string;role:string}>();
  if (!workspaceId && membership && 'workspaceId' in membership) workspaceId = String(membership.workspaceId ?? '');
  if (!workspaceId || !membership || !['owner', 'admin'].includes(membership.role)) return json({ error: 'admin access required' }, 403);
  return { actor, workspaceId, role: membership.role };
}

function parsePayload(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value) return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; } catch { return null; }
}

export async function handleWebhookAdminApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/admin/webhook-deliveries')) return null;
  const context = await adminContext(request, env);
  if (context instanceof Response) return context;
  if (env.OPS_RATE_LIMITER && !(await env.OPS_RATE_LIMITER.limit({ key: `webhook-admin:${context.workspaceId}:${context.actor.subject}` })).success) return json({ error: 'rate limit exceeded' }, 429);
  if (request.method === 'GET' && url.pathname === '/api/admin/webhook-deliveries') {
    const status = url.searchParams.get('status') ?? '';
    if (status && !STATUSES.has(status)) return json({ error: 'invalid status' }, 400);
    const offset = Math.max(0, Math.min(10_000, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0));
    const limit = Math.max(1, Math.min(100, Number.parseInt(url.searchParams.get('limit') ?? '50', 10) || 50));
    const rows = status
      ? await env.CRM_DB!.prepare("SELECT d.id,d.event_id as eventId,d.event_type as eventType,d.status,d.attempts,d.response_status as responseStatus,d.last_error as lastError,d.replay_count as replayCount,d.last_replayed_at as lastReplayedAt,d.created_at as createdAt,d.updated_at as updatedAt,d.delivered_at as deliveredAt,w.name as webhookName,w.url as targetUrl,CASE WHEN d.payload_json IS NOT NULL OR EXISTS(SELECT 1 FROM crm_event_outbox o WHERE o.workspace_id=d.workspace_id AND o.event_id=d.event_id AND o.payload_json IS NOT NULL) THEN 1 ELSE 0 END as hasPayload FROM webhook_deliveries d JOIN native_webhooks w ON w.id=d.webhook_id AND w.workspace_id=d.workspace_id WHERE d.workspace_id=? AND d.status=? ORDER BY d.created_at DESC,d.id DESC LIMIT ? OFFSET ?").bind(context.workspaceId, status, limit, offset).all<Record<string,unknown>>()
      : await env.CRM_DB!.prepare("SELECT d.id,d.event_id as eventId,d.event_type as eventType,d.status,d.attempts,d.response_status as responseStatus,d.last_error as lastError,d.replay_count as replayCount,d.last_replayed_at as lastReplayedAt,d.created_at as createdAt,d.updated_at as updatedAt,d.delivered_at as deliveredAt,w.name as webhookName,w.url as targetUrl,CASE WHEN d.payload_json IS NOT NULL OR EXISTS(SELECT 1 FROM crm_event_outbox o WHERE o.workspace_id=d.workspace_id AND o.event_id=d.event_id AND o.payload_json IS NOT NULL) THEN 1 ELSE 0 END as hasPayload FROM webhook_deliveries d JOIN native_webhooks w ON w.id=d.webhook_id AND w.workspace_id=d.workspace_id WHERE d.workspace_id=? ORDER BY d.created_at DESC,d.id DESC LIMIT ? OFFSET ?").bind(context.workspaceId, limit, offset).all<Record<string,unknown>>();
    const total = status
      ? await env.CRM_DB!.prepare('SELECT COUNT(*) as count FROM webhook_deliveries WHERE workspace_id=? AND status=?').bind(context.workspaceId, status).first<{count:number}>()
      : await env.CRM_DB!.prepare('SELECT COUNT(*) as count FROM webhook_deliveries WHERE workspace_id=?').bind(context.workspaceId).first<{count:number}>();
    return json({ data: rows.results.map(row => ({ ...row, hasPayload: Boolean(row.hasPayload), replayable: REPLAYABLE.has(String(row.status)) && Boolean(row.hasPayload) })), page: { offset, limit, total: Number(total?.count ?? 0) } });
  }
  const replay = url.pathname.match(/^\/api\/admin\/webhook-deliveries\/([A-Za-z0-9_-]{1,128})\/replay$/);
  if (replay && request.method === 'POST') {
    if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return json({ error: 'cross-origin request denied' }, 403);
    const body = await request.json().catch(() => null) as Record<string,unknown>|null;
    if (body?.confirm !== true) return json({ error: 'explicit replay confirmation is required' }, 400);
    const row = await env.CRM_DB!.prepare("SELECT d.id,d.event_id as eventId,d.event_type as eventType,d.status,d.replay_count as replayCount,d.payload_json as payloadJson,o.payload_json as outboxPayload FROM webhook_deliveries d LEFT JOIN crm_event_outbox o ON o.workspace_id=d.workspace_id AND o.event_id=d.event_id WHERE d.id=? AND d.workspace_id=? LIMIT 1").bind(replay[1], context.workspaceId).first<{id:string;eventId:string;eventType:string;status:string;replayCount:number;payloadJson:string|null;outboxPayload:string|null}>();
    if (!row) return json({ error: 'delivery not found' }, 404);
    if (!REPLAYABLE.has(row.status)) return json({ error: 'only failed or terminal deliveries can be replayed' }, 409);
    const payload = parsePayload(row.payloadJson) ?? parsePayload(row.outboxPayload);
    if (!payload) return json({ error: 'original payload is unavailable; replay was not attempted' }, 409);
    const now = new Date().toISOString();
    const updated = await env.CRM_DB!.prepare("UPDATE webhook_deliveries SET status='queued',payload_json=?,response_status=NULL,last_error=NULL,delivered_at=NULL,replay_count=replay_count+1,last_replayed_at=?,replayed_by=?,updated_at=? WHERE id=? AND workspace_id=? AND status IN ('failed','dead')").bind(JSON.stringify(payload), now, context.actor.subject, now, row.id, context.workspaceId).run();
    if (Number(updated.meta?.changes ?? 0) !== 1) return json({ error: 'delivery state changed; refresh before replaying' }, 409);
    const replayCount = row.replayCount + 1;
    const jobId = await compatibilityId(`webhook-replay:${row.id}:${replayCount}`);
    const job: CloudflareTwentyJob = { schemaVersion: 1, id: jobId, queueName: 'twenty-jobs', jobName: 'webhook.deliver', data: { deliveryId: row.id, workspaceId: context.workspaceId }, createdAt: now, retryLimit: 8, priority: 0, dedupeKey: `webhook:${row.id}:replay:${replayCount}`, retainDedupe: true };
    try {
      await env.JOBS_QUEUE.send(job);
    } catch (error) {
      await env.CRM_DB!.prepare("UPDATE webhook_deliveries SET status='failed',last_error=?,updated_at=? WHERE id=? AND workspace_id=? AND status='queued'").bind(`Replay enqueue failed: ${String(error)}`.slice(0,500), new Date().toISOString(), row.id, context.workspaceId).run();
      return json({ error: 'replay could not be queued' }, 503);
    }
    await env.CRM_DB!.prepare("INSERT INTO crm_audit_events (id,workspace_id,actor_subject,action,object_type,object_id,request_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(), context.workspaceId, context.actor.subject, 'replay', 'webhook_delivery', row.id, request.headers.get('x-request-id')?.slice(0,128) || crypto.randomUUID(), JSON.stringify({ eventId: row.eventId, replayCount, jobId }), now).run();
    return json({ data: { id: row.id, eventId: row.eventId, status: 'queued', replayCount, jobId } }, 202);
  }
  return json({ error: 'method not allowed' }, 405);
}

export async function webhookAdminPage(request: Request, env: Env): Promise<Response> {
  const context = await adminContext(request, env);
  if (context instanceof Response) return context;
  const nonce = crypto.randomUUID().replaceAll('-', '');
  const workspace = JSON.stringify(context.workspaceId).replaceAll('<', '\\u003c');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Webhook deliveries · Twenty</title><style>html{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:#141414;background:#f7f7f7}*{box-sizing:border-box}body{margin:0}.shell{max-width:1180px;margin:0 auto;padding:32px 24px}.top,.filters,.pager{display:flex;align-items:center;gap:12px;justify-content:space-between}.top{margin-bottom:28px}.back{color:#555;text-decoration:none}.card{background:#fff;border:1px solid #e4e4e4;border-radius:8px;overflow:hidden}.filters{padding:16px;border-bottom:1px solid #eee}h1{font-size:24px;margin:0 0 6px}p{margin:0;color:#666}.hint{font-size:12px;margin-top:6px}.table{overflow:auto}table{width:100%;border-collapse:collapse;min-width:900px}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top}th{color:#666;font-weight:600;background:#fafafa}.status{font-weight:600;text-transform:capitalize}.failed,.dead{color:#b42318}.delivered{color:#067647}.queued,.delivering{color:#175cd3}button,select{font:inherit;border:1px solid #d0d5dd;border-radius:6px;padding:8px 11px;background:#fff}button{cursor:pointer}button.primary{background:#141414;color:#fff;border-color:#141414}button:disabled{cursor:not-allowed;opacity:.45}.unavailable{display:inline-block;max-width:110px;color:#777;font-size:12px;line-height:1.25}.error{max-width:300px;color:#b42318;white-space:normal}.pager{padding:14px}.empty{padding:42px;text-align:center;color:#777}@media(prefers-color-scheme:dark){html{background:#1b1b1b;color:#f5f5f5}.card,button,select{background:#222;color:#f5f5f5;border-color:#3a3a3a}th{background:#252525;color:#aaa}th,td,.filters{border-color:#333}.back,p{color:#aaa}}</style></head><body><main class="shell"><div class="top"><div><h1>Webhook delivery history</h1><p>Inspect failures and safely replay the original signed payload.</p><p class="hint">Legacy deliveries created before payload retention cannot be replayed.</p></div><a class="back" href="/settings/profile">← Back to settings</a></div><section class="card"><div class="filters"><label>Status <select id="status"><option value="">All</option><option>failed</option><option>dead</option><option>queued</option><option>delivering</option><option>delivered</option></select></label><button id="refresh">Refresh</button></div><div class="table"><table><thead><tr><th>Webhook</th><th>Event</th><th>Status</th><th>Attempts</th><th>Response</th><th>Updated</th><th>Error</th><th>Action</th></tr></thead><tbody id="rows"></tbody></table><div class="empty" id="empty" hidden>No deliveries found.</div></div><div class="pager"><button id="previous">Previous</button><span id="page"></span><button id="next">Next</button></div></section></main><script nonce="${nonce}">const workspaceId=${workspace},limit=50;let offset=0,total=0;const el=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));async function api(path,init={}){const response=await fetch(path,{...init,headers:{'content-type':'application/json','x-workspace-id':workspaceId,...(init.headers||{})}});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body.error||('HTTP '+response.status));return body}function render(data){total=data.page.total;el('rows').innerHTML=data.data.map(row=>'<tr><td><strong>'+esc(row.webhookName)+'</strong><br><small>'+esc(row.targetUrl)+'</small></td><td>'+esc(row.eventType)+'<br><small>'+esc(row.eventId)+'</small></td><td class="status '+esc(row.status)+'">'+esc(row.status)+(row.replayCount?' · replay '+row.replayCount:'')+'</td><td>'+esc(row.attempts)+'</td><td>'+esc(row.responseStatus??'—')+'</td><td>'+esc(new Date(row.updatedAt).toLocaleString())+'</td><td class="error">'+esc(row.lastError??'')+'</td><td>'+(row.replayable?'<button class="primary replay" data-id="'+esc(row.id)+'" title="Replay failed delivery">Replay</button>':'<span class="unavailable" title="The original payload was not retained">Payload unavailable</span>')+'</td></tr>').join('');el('empty').hidden=data.data.length!==0;el('page').textContent=(total?offset+1:0)+'–'+Math.min(offset+limit,total)+' of '+total;el('previous').disabled=offset===0;el('next').disabled=offset+limit>=total;document.querySelectorAll('.replay').forEach(button=>button.addEventListener('click',()=>replay(button.dataset.id,button)))}async function load(){const status=el('status').value;const data=await api('/api/admin/webhook-deliveries?limit='+limit+'&offset='+offset+(status?'&status='+encodeURIComponent(status):''));render(data)}async function replay(id,button){if(!confirm('Replay this webhook using its original payload?'))return;button.disabled=true;try{await api('/api/admin/webhook-deliveries/'+encodeURIComponent(id)+'/replay',{method:'POST',body:JSON.stringify({confirm:true})});await load()}catch(error){alert(error.message);button.disabled=false}}el('refresh').onclick=()=>load().catch(error=>alert(error.message));el('status').onchange=()=>{offset=0;load().catch(error=>alert(error.message))};el('previous').onclick=()=>{offset=Math.max(0,offset-limit);load().catch(error=>alert(error.message))};el('next').onclick=()=>{offset+=limit;load().catch(error=>alert(error.message))};load().catch(error=>alert(error.message));</script></body></html>`;
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store', 'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`, 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });
}
