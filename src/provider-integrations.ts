import { accessIdentityForRequest } from './access';
import { decryptProviderValue, encryptProviderValue, providerDigest, randomProviderSecret } from './provider-crypto';
import type { CloudflareTwentyJob, Env } from './types';

type Provider='google'|'microsoft';
type Tokens={access_token:string;refresh_token?:string;expires_in?:number;expires_at?:string;scope?:string;token_type?:string};
type Member={workspaceId:string;role:string;subject:string};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
const admin=(role:string)=>role==='owner'||role==='admin';
const providerConfig=(provider:Provider,env:Env)=>provider==='google'
  ? {clientId:env.GOOGLE_OAUTH_CLIENT_ID,clientSecret:env.GOOGLE_OAUTH_CLIENT_SECRET,authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',revoke:'https://oauth2.googleapis.com/revoke',profile:'https://openidconnect.googleapis.com/v1/userinfo',scopes:['openid','email','profile','https://www.googleapis.com/auth/calendar.readonly','https://www.googleapis.com/auth/gmail.readonly']}
  : {clientId:env.MICROSOFT_OAUTH_CLIENT_ID,clientSecret:env.MICROSOFT_OAUTH_CLIENT_SECRET,authorize:`https://login.microsoftonline.com/${env.MICROSOFT_OAUTH_TENANT_ID||'common'}/oauth2/v2.0/authorize`,token:`https://login.microsoftonline.com/${env.MICROSOFT_OAUTH_TENANT_ID||'common'}/oauth2/v2.0/token`,revoke:null,profile:'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName',scopes:['openid','email','profile','offline_access','User.Read','Calendars.Read','Mail.Read']};
const callbackUrl=(origin:string,provider:Provider)=>`${origin}/api/integrations/oauth/${provider}/callback`;
const validReturnPath=(value:string|null)=>value&&value.startsWith('/')&&!value.startsWith('//')&&value.length<=500?value:'/settings/accounts';
const timeout=()=>AbortSignal.timeout(10_000);

async function membership(request:Request,env:Env,workspaceId?:string):Promise<Member|Response>{
  const actor=await accessIdentityForRequest(request,env);if(!actor)return json({error:'unauthorized'},401);
  const selected=workspaceId??request.headers.get('x-workspace-id')??'';if(!/^[A-Za-z0-9_-]{1,128}$/.test(selected))return json({error:'x-workspace-id is required'},400);
  const row=actor.authenticationType==='api-key'
    ? actor.workspaceId===selected&&actor.workspaceRole?{role:actor.workspaceRole}:null
    : await env.CRM_DB!.prepare("SELECT COALESCE('custom:'||ra.role_id,m.role) AS role FROM workspace_members m LEFT JOIN role_assignments ra ON ra.workspace_id=m.workspace_id AND ra.identity_subject=m.identity_subject WHERE m.workspace_id=? AND m.identity_subject=? AND m.status='active'").bind(selected,actor.subject).first<{role:string}>();
  if(!row)return json({error:'workspace access denied'},403);return{workspaceId:selected,role:String(row.role),subject:actor.subject};
}
async function start(request:Request,env:Env,provider:Provider){
  const member=await membership(request,env);if(member instanceof Response)return member;if(!admin(member.role))return json({error:'admin access required'},403);
  const config=providerConfig(provider,env);if(!config.clientId||!config.clientSecret||!env.INTEGRATION_ENCRYPTION_KEY)return json({error:`${provider} OAuth is not configured`,code:'PROVIDER_NOT_CONFIGURED'},503);
  const requestOrigin=new URL(request.url).origin;
  const state=randomProviderSecret(32),verifier=randomProviderSecret(64),challenge=await providerDigest(verifier),now=new Date(),expires=new Date(now.getTime()+10*60_000).toISOString();
  const encrypted=await encryptProviderValue(env,{verifier},`oauth-state:${member.workspaceId}:${member.subject}:${provider}`);
  await env.CRM_DB!.prepare('INSERT INTO provider_oauth_states (state_hash,workspace_id,actor_subject,provider,encrypted_verifier,verifier_iv,return_path,expires_at,created_at,callback_origin) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(await providerDigest(state),member.workspaceId,member.subject,provider,encrypted.ciphertext,encrypted.iv,validReturnPath(new URL(request.url).searchParams.get('returnPath')),expires,now.toISOString(),requestOrigin).run();
  const url=new URL(config.authorize);url.searchParams.set('client_id',config.clientId);url.searchParams.set('redirect_uri',callbackUrl(requestOrigin,provider));url.searchParams.set('response_type','code');url.searchParams.set('scope',config.scopes.join(' '));url.searchParams.set('state',state);url.searchParams.set('code_challenge',challenge);url.searchParams.set('code_challenge_method','S256');
  if(provider==='google'){url.searchParams.set('access_type','offline');url.searchParams.set('prompt','consent');}
  return json({data:{provider,authorizationUrl:url.toString(),expiresAt:expires}});
}
async function callback(request:Request,env:Env,provider:Provider){
  const url=new URL(request.url),state=url.searchParams.get('state')??'',code=url.searchParams.get('code')??'';if(state.length<30||code.length<3)return json({error:'invalid OAuth callback'},400);
  const stateHash=await providerDigest(state),now=new Date().toISOString();
  const stored=await env.CRM_DB!.prepare('SELECT workspace_id as workspaceId,actor_subject as actorSubject,provider,encrypted_verifier as encryptedVerifier,verifier_iv as verifierIv,return_path as returnPath,expires_at as expiresAt,consumed_at as consumedAt,callback_origin as callbackOrigin FROM provider_oauth_states WHERE state_hash=?').bind(stateHash).first<Record<string,string|null>>();
  if(!stored||stored.provider!==provider||stored.consumedAt||String(stored.expiresAt)<=now)return json({error:'OAuth state is invalid or expired'},400);
  const storedOrigin=stored.callbackOrigin??new URL(env.SERVER_URL).origin;if(storedOrigin!==url.origin)return json({error:'OAuth callback origin mismatch'},403);
  const member=await membership(request,env,String(stored.workspaceId));if(member instanceof Response)return member;if(member.subject!==stored.actorSubject||!admin(member.role))return json({error:'OAuth state owner mismatch'},403);
  const claimed=await env.CRM_DB!.prepare('UPDATE provider_oauth_states SET consumed_at=? WHERE state_hash=? AND consumed_at IS NULL AND expires_at>?').bind(now,stateHash,now).run();if(Number(claimed.meta?.changes??0)!==1)return json({error:'OAuth state was already consumed'},409);
  const config=providerConfig(provider,env);if(!config.clientId||!config.clientSecret)return json({error:`${provider} OAuth is not configured`,code:'PROVIDER_NOT_CONFIGURED'},503);
  const{verifier}=await decryptProviderValue<{verifier:string}>(env,String(stored.encryptedVerifier),String(stored.verifierIv),`oauth-state:${member.workspaceId}:${member.subject}:${provider}`);
  const form=new URLSearchParams({client_id:config.clientId,client_secret:config.clientSecret,code,grant_type:'authorization_code',redirect_uri:callbackUrl(storedOrigin,provider),code_verifier:verifier});
  const tokenResponse=await fetch(config.token,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded','accept':'application/json'},body:form,signal:timeout()});
  const tokenBody=await tokenResponse.json().catch(()=>({})) as Partial<Tokens>&{error?:string};if(!tokenResponse.ok||typeof tokenBody.access_token!=='string')return json({error:'OAuth token exchange failed',provider,status:tokenResponse.status,code:tokenBody.error??'TOKEN_EXCHANGE_FAILED'},502);
  const expiresAt=tokenBody.expires_in?new Date(Date.now()+Number(tokenBody.expires_in)*1000).toISOString():undefined;const tokens:Tokens={...tokenBody,access_token:tokenBody.access_token,expires_at:expiresAt};
  const profileResponse=await fetch(config.profile,{headers:{authorization:`Bearer ${tokens.access_token}`,accept:'application/json'},signal:timeout()});const profile=await profileResponse.json().catch(()=>({})) as Record<string,unknown>;if(!profileResponse.ok)return json({error:'OAuth profile validation failed',provider,status:profileResponse.status},502);
  const accountId=crypto.randomUUID(),name=String(profile.name??profile.displayName??profile.email??profile.mail??profile.userPrincipalName??`${provider} account`).slice(0,160),encrypted=await encryptProviderValue(env,tokens,`integration:${member.workspaceId}:${accountId}:${provider}`);
  await env.CRM_DB!.batch([
    env.CRM_DB!.prepare("INSERT INTO integration_accounts (id,workspace_id,account_type,name,status,config_json,created_at,updated_at) VALUES (?,?,?,?,'connected','{}',?,?)").bind(accountId,member.workspaceId,provider,name,now,now),
    env.CRM_DB!.prepare('INSERT INTO integration_credentials (account_id,workspace_id,provider,encrypted_tokens,token_iv,scopes_json,token_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(accountId,member.workspaceId,provider,encrypted.ciphertext,encrypted.iv,JSON.stringify(String(tokens.scope??'').split(' ').filter(Boolean)),expiresAt??null,now,now),
    env.CRM_DB!.prepare('INSERT INTO integration_sync_state (account_id,workspace_id,updated_at) VALUES (?,?,?)').bind(accountId,member.workspaceId,now),
    env.CRM_DB!.prepare('INSERT INTO crm_audit_events (id,workspace_id,actor_subject,action,object_type,object_id,request_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),member.workspaceId,member.subject,'connect','integration_account',accountId,request.headers.get('cf-ray')??crypto.randomUUID(),JSON.stringify({provider}),now),
  ]);
  const redirect=new URL(String(stored.returnPath),storedOrigin);redirect.searchParams.set('providerConnected',provider);return Response.redirect(redirect.toString(),303);
}

export async function handleProviderIntegrationApi(request:Request,env:Env):Promise<Response|null>{
  const requestUrl=new URL(request.url),path=requestUrl.pathname;if(!['GET','HEAD','OPTIONS'].includes(request.method)){const origin=request.headers.get('origin');if(origin&&origin!==requestUrl.origin)return json({error:'cross-origin request denied'},403);}const oauth=path.match(/^\/api\/integrations\/oauth\/(google|microsoft)\/(start|callback)$/);if(oauth){const provider=oauth[1] as Provider;return oauth[2]==='start'&&request.method==='POST'?start(request,env,provider):oauth[2]==='callback'&&request.method==='GET'?callback(request,env,provider):json({error:'method not allowed'},405);}
  if(!path.startsWith('/api/integrations'))return null;const member=await membership(request,env);if(member instanceof Response)return member;
  if(path==='/api/integrations'&&request.method==='GET'){const rows=await env.CRM_DB!.prepare("SELECT id,account_type as provider,name,status,created_at as createdAt,updated_at as updatedAt FROM integration_accounts WHERE workspace_id=? ORDER BY updated_at DESC").bind(member.workspaceId).all();return json({data:rows.results});}
  const match=path.match(/^\/api\/integrations\/([A-Za-z0-9_-]{1,128})\/(sync|disconnect)$/);if(!match)return json({error:'not found'},404);if(!admin(member.role))return json({error:'admin access required'},403);
  const account=await env.CRM_DB!.prepare('SELECT id,account_type as provider,status FROM integration_accounts WHERE id=? AND workspace_id=?').bind(match[1],member.workspaceId).first<{id:string;provider:Provider;status:string}>();if(!account)return json({error:'integration account not found'},404);
  if(match[2]==='sync'&&request.method==='POST'){if(account.status!=='connected')return json({error:'integration account is not connected'},409);if(!env.JOBS_QUEUE)return json({error:'provider synchronization queue is unavailable'},503);const now=new Date().toISOString(),job:CloudflareTwentyJob={schemaVersion:1,id:crypto.randomUUID(),queueName:'twenty-jobs',jobName:'provider.sync',data:{workspaceId:member.workspaceId,accountId:account.id},createdAt:now,retryLimit:5,priority:0,dedupeKey:`provider-sync:${member.workspaceId}:${account.id}:${now.slice(0,16)}`};await env.JOBS_QUEUE.send(job);return json({data:{queued:true,jobId:job.id}},202);}
  if(match[2]==='disconnect'&&request.method==='POST'){const credential=await env.CRM_DB!.prepare('SELECT encrypted_tokens as encryptedTokens,token_iv as tokenIv FROM integration_credentials WHERE account_id=? AND workspace_id=?').bind(account.id,member.workspaceId).first<{encryptedTokens:string;tokenIv:string}>();if(credential){const tokens=await decryptProviderValue<Tokens>(env,credential.encryptedTokens,credential.tokenIv,`integration:${member.workspaceId}:${account.id}:${account.provider}`);if(account.provider==='google'){const config=providerConfig('google',env);const token=tokens.refresh_token??tokens.access_token;if(config.revoke&&token){const response=await fetch(config.revoke,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token}),signal:timeout()});if(!response.ok&&response.status!==400)return json({error:'provider token revocation failed',status:response.status},502);}}}
    const disconnectedAt=new Date().toISOString();await env.CRM_DB!.batch([env.CRM_DB!.prepare('DELETE FROM integration_credentials WHERE account_id=? AND workspace_id=?').bind(account.id,member.workspaceId),env.CRM_DB!.prepare("UPDATE integration_accounts SET status='disconnected',config_json='{}',updated_at=? WHERE id=? AND workspace_id=?").bind(disconnectedAt,account.id,member.workspaceId),env.CRM_DB!.prepare('INSERT INTO crm_audit_events (id,workspace_id,actor_subject,action,object_type,object_id,request_id,metadata_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(crypto.randomUUID(),member.workspaceId,member.subject,'disconnect','integration_account',account.id,request.headers.get('cf-ray')??crypto.randomUUID(),JSON.stringify({provider:account.provider}),disconnectedAt)]);return json({data:{id:account.id,status:'disconnected',remoteRevocation:account.provider==='google'?'requested':'not-supported-by-provider'}});}
  return json({error:'method not allowed'},405);
}

export async function providerTokens(env:Env,workspaceId:string,accountId:string):Promise<{provider:Provider;tokens:Tokens}|null>{
  const row=await env.CRM_DB!.prepare('SELECT c.provider,c.encrypted_tokens as encryptedTokens,c.token_iv as tokenIv FROM integration_credentials c JOIN integration_accounts a ON a.id=c.account_id AND a.workspace_id=c.workspace_id WHERE c.account_id=? AND c.workspace_id=? AND a.status=\'connected\'').bind(accountId,workspaceId).first<{provider:Provider;encryptedTokens:string;tokenIv:string}>();if(!row)return null;return{provider:row.provider,tokens:await decryptProviderValue<Tokens>(env,row.encryptedTokens,row.tokenIv,`integration:${workspaceId}:${accountId}:${row.provider}`)};
}
