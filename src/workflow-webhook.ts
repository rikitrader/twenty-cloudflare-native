import { accessIdentityForRequest } from './access';
import type { Env } from './types';

const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
const hash=async(value:string)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');

function webhookTrigger(value:unknown):{httpMethod:'GET'|'POST'}|null{
  if(!value||typeof value!=='object'||Array.isArray(value))return null;const raw=value as Record<string,unknown>;
  if(String(raw.type??'').toUpperCase()!=='WEBHOOK')return null;const settings=raw.settings&&typeof raw.settings==='object'&&!Array.isArray(raw.settings)?raw.settings as Record<string,unknown>:{};
  const method=String(settings.httpMethod??'POST').toUpperCase();return method==='GET'||method==='POST'?{httpMethod:method}:null;
}

/** Authenticated public trigger used by Twenty's WEBHOOK workflow node. */
export async function handleWorkflowWebhook(request:Request,env:Env,workflowId:string):Promise<Response>{
  if(!env.CRM_DB)return json({error:'workflow persistence unavailable'},503);
  const actor=await accessIdentityForRequest(request,env);if(!actor||actor.authenticationType!=='api-key'||!actor.workspaceId)return json({error:'API key required'},401);
  if(env.OPS_RATE_LIMITER&&!(await env.OPS_RATE_LIMITER.limit({key:`workflow-webhook:${actor.workspaceId}:${workflowId}`})).success)return json({error:'rate limit exceeded'},429);
  const version=await env.CRM_DB.prepare("SELECT v.id AS versionId,v.trigger_json AS triggerJson,w.created_by AS createdBy FROM native_workflow_versions v JOIN native_workflows w ON w.id=v.workflow_id AND w.workspace_id=v.workspace_id WHERE v.workspace_id=? AND v.workflow_id=? AND v.status='ACTIVE' AND w.status='active' LIMIT 1").bind(actor.workspaceId,workflowId).first<{versionId:string;triggerJson:string|null;createdBy:string}>();
  if(!version)return json({error:'active workflow not found'},404);let trigger:ReturnType<typeof webhookTrigger>=null;try{trigger=webhookTrigger(version.triggerJson?JSON.parse(version.triggerJson):null);}catch{return json({error:'stored workflow trigger is invalid'},409);}if(!trigger)return json({error:'workflow does not have a webhook trigger'},409);if(request.method!==trigger.httpMethod)return json({error:`workflow expects ${trigger.httpMethod}`},405);
  const length=Number(request.headers.get('content-length')??0);if(!Number.isFinite(length)||length<0||length>100_000)return json({error:'payload too large'},413);
  const url=new URL(request.url);let payload:unknown={};let raw='';if(request.method==='POST'){raw=await request.text();if(raw.length>100_000)return json({error:'payload too large'},413);try{payload=raw?JSON.parse(raw):{};}catch{return json({error:'JSON body required'},400);}}else payload=Object.fromEntries(url.searchParams);
  const supplied=request.headers.get('idempotency-key');if(supplied&&!/^[A-Za-z0-9._:-]{1,128}$/.test(supplied))return json({error:'invalid idempotency key'},400);const dedupe=supplied??await hash(`${request.method}:${url.search}:${raw}`);const runId=(await hash(`webhook:${actor.workspaceId}:${workflowId}:${dedupe}`)).slice(0,32),now=new Date().toISOString();
  const inserted=await env.CRM_DB.prepare("INSERT OR IGNORE INTO native_workflow_runs (id,workflow_id,workspace_id,status,input_json,created_by,created_at,updated_at) VALUES (?,?,?,'queued',?,?,?,?)").bind(runId,workflowId,actor.workspaceId,JSON.stringify({trigger:{type:'WEBHOOK',workflowVersionId:version.versionId},payload}),actor.subject,now,now).run();
  if(Number(inserted.meta?.changes??0)!==1){const existing=await env.CRM_DB.prepare('SELECT status FROM native_workflow_runs WHERE id=? AND workspace_id=?').bind(runId,actor.workspaceId).first<{status:string}>();if(!existing)return json({error:'duplicate workflow receipt is unavailable'},409);return json({data:{id:runId,status:existing.status,duplicate:true}},existing.status==='queued'||existing.status==='running'?202:200);}
  try{await env.JOBS_QUEUE.send({schemaVersion:1,id:runId,queueName:'twenty-jobs',jobName:'workflow.run',data:{runId,workflowId,workspaceId:actor.workspaceId,actorSubject:actor.subject},createdAt:now,retryLimit:3,priority:0,dedupeKey:`workflow-webhook:${runId}`});}
  catch(error){await env.CRM_DB.prepare("UPDATE native_workflow_runs SET status='failed',error=?,updated_at=? WHERE id=? AND workspace_id=?").bind(`queue unavailable: ${String(error).slice(0,300)}`,new Date().toISOString(),runId,actor.workspaceId).run();return json({error:'workflow queue unavailable'},503);}
  return json({data:{id:runId,status:'queued',duplicate:false}},202);
}
