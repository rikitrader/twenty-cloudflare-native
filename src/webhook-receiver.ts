import { enqueueOutboundWebhooks } from './outbound-webhooks';
import type { Env } from './types';
import { accessIdentityForRequest } from './access';

export { handleRegisteredWebhookReceiver } from './webhook-receipt';

const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);

export async function handleWebhookSelfTest(request:Request,env:Env):Promise<Response>{
  if(request.method!=='POST')return new Response('method not allowed',{status:405});const actor=await accessIdentityForRequest(request,env);if(!actor)return new Response('unauthorized',{status:401});const body=await request.json().catch(()=>null) as Record<string,unknown>|null,workspaceId=body?.workspaceId;if(!validId(workspaceId))return Response.json({error:'workspaceId is required'},{status:400});let role:string|undefined;if(actor.authenticationType==='api-key'&&actor.workspaceId===workspaceId)role=actor.workspaceRole;else role=String((await env.CRM_DB!.prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND identity_subject=? AND status='active'").bind(workspaceId,actor.subject).first<{role:string}>())?.role??'');if(!['owner','admin'].includes(role??''))return new Response('admin access required',{status:403});
  const now=new Date().toISOString(),url=new URL('/webhooks/receiver',env.SERVER_URL).toString(),hookId=`cf-self-${workspaceId}`;await env.CRM_DB!.prepare("INSERT INTO native_webhooks (id,workspace_id,name,url,events_json,active,created_at,updated_at) VALUES (?,?,'Cloudflare production receiver',?,'[\"webhook.self-test\"]',1,?,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url,events_json=excluded.events_json,active=1,updated_at=excluded.updated_at WHERE native_webhooks.workspace_id=excluded.workspace_id").bind(hookId,workspaceId,url,now,now).run();const eventId=crypto.randomUUID();await enqueueOutboundWebhooks(env,eventId,'webhook.self-test',{workspaceId,action:'self-test',objectType:'webhook',objectId:eventId});return Response.json({data:{eventId,status:'queued',receiverHost:new URL(url).hostname}},{status:202,headers:{'cache-control':'no-store'}});
}
