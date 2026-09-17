import { verifyTwentyWebhookSignature } from './lib';
import type { Env } from './types';

const validId=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);

export async function handleRegisteredWebhookReceiver(request:Request,env:Env):Promise<Response>{
  if(request.method!=='POST')return new Response('method not allowed',{status:405});const declared=Number(request.headers.get('content-length')??0);if(!Number.isFinite(declared)||declared<0||declared>100_000)return new Response('payload too large',{status:413});const raw=await request.text();
  if(!await verifyTwentyWebhookSignature(raw,request.headers.get('x-twenty-webhook-timestamp'),request.headers.get('x-twenty-webhook-signature'),env.OUTBOUND_WEBHOOK_SECRET))return new Response('invalid webhook signature',{status:401});
  let body:Record<string,unknown>;try{body=JSON.parse(raw);}catch{return new Response('malformed payload',{status:400});}const eventId=body.id,workspaceId=body.workspaceId,eventType=body.event;if(!validId(eventId)||!validId(workspaceId)||typeof eventType!=='string'||eventType.length>160)return new Response('invalid payload',{status:400});const workspace=await env.CRM_DB!.prepare('SELECT 1 FROM workspaces WHERE id=?').bind(workspaceId).first();if(!workspace)return new Response('unknown workspace',{status:404});
  await env.CRM_DB!.prepare('INSERT OR IGNORE INTO webhook_receiver_events (event_id,workspace_id,event_type,payload_json,received_at) VALUES (?,?,?,?,?)').bind(eventId,workspaceId,eventType,raw,new Date().toISOString()).run();return new Response('accepted',{status:202,headers:{'cache-control':'no-store'}});
}
