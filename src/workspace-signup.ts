import type { Env } from './types';
import { createNativeSession, hashPassword, nativeSessionCookie } from './native-auth';

type Invitation = { id:string; workspaceId:string; workspaceName:string; role:'member'|'admin' };

export async function workspaceSignup(request: Request, env: Env, vars: Record<string, unknown>, input: Record<string, unknown>, op:string): Promise<Response> {
  const db = env.CRM_DB!;
  const email = String(vars.email ?? input.email ?? '').trim().toLowerCase();
  const password = String(vars.password ?? input.password ?? '');
  const reject = (message:string, status:number) => Response.json({errors:[{message}]}, {status});
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 10 || password.length > 256) return reject('email or password does not meet requirements', 400);
  if (env.OPS_RATE_LIMITER && !(await env.OPS_RATE_LIMITER.limit({key:`signup:${email}`})).success) return reject('too many signup attempts',429);
  const requestedWorkspace = String(vars.workspaceId ?? input.workspaceId ?? '');
  const rawInvite = String(vars.workspacePersonalInviteToken ?? input.workspacePersonalInviteToken ?? vars.workspaceInviteHash ?? input.workspaceInviteHash ?? '');
  let invitation:Invitation|null = null;
  if (requestedWorkspace || rawInvite) {
    if (/SignUpInNewWorkspace/i.test(op) || !rawInvite || rawInvite.length > 512) return reject('a valid workspace invitation is required',403);
    const digest = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(rawInvite));
    const hash = [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
    invitation = await db.prepare("SELECT i.id, i.workspace_id as workspaceId, w.name as workspaceName, i.role FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id WHERE i.token_hash = ? AND i.email = ? COLLATE NOCASE AND i.status = 'pending' AND i.expires_at > ? LIMIT 1")
      .bind(hash,email,new Date().toISOString()).first<Invitation>();
    if (!invitation || (requestedWorkspace && invitation.workspaceId !== requestedWorkspace)) return reject('a valid workspace invitation is required',403);
  }
  if (await db.prepare('SELECT 1 FROM native_users WHERE email = ? COLLATE NOCASE LIMIT 1').bind(email).first()) return reject('account already exists',409);
  const userId = crypto.randomUUID();
  const workspaceId = invitation?.workspaceId ?? crypto.randomUUID();
  const workspaceName = invitation?.workspaceName ?? String(input.workspaceName ?? `${email.split('@')[0]}'s workspace`).slice(0,120);
  const now = new Date().toISOString();
  const encoded = await hashPassword(password);
  // Recheck the invitation inside the atomic D1 batch. NULL violates the
  // email NOT NULL constraint if it was revoked/consumed/expired after lookup,
  // rolling back the ENTIRE batch before any membership can be granted.
  const userInsert = invitation
    ? db.prepare("INSERT INTO native_users (id,email,password_hash,password_salt,created_at,updated_at) VALUES (?, CASE WHEN EXISTS (SELECT 1 FROM workspace_invitations WHERE id = ? AND email = ? COLLATE NOCASE AND status = 'pending' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) THEN ? ELSE NULL END, ?, ?, ?, ?)")
      .bind(userId,invitation.id,email,email,encoded.hash,encoded.salt,now,now)
    : db.prepare('INSERT INTO native_users (id,email,password_hash,password_salt,created_at,updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(userId,email,encoded.hash,encoded.salt,now,now);
  const statements = [userInsert];
  if (!invitation) statements.push(db.prepare('INSERT INTO workspaces (id,name,created_at) VALUES (?, ?, ?)').bind(workspaceId,workspaceName,now));
  statements.push(db.prepare("INSERT INTO workspace_members (workspace_id,identity_subject,role,status,created_at) VALUES (?, ?, ?, 'active', ?)")
    .bind(workspaceId,`user:${userId}`,invitation?.role ?? 'owner',now));
  if (invitation) statements.push(db.prepare("UPDATE workspace_invitations SET status = 'accepted', accepted_at = ? WHERE id = ? AND status = 'pending'").bind(now,invitation.id));
  try { await db.batch(statements); } catch { return reject('signup could not be completed; check the account or invitation',409); }
  const session = await createNativeSession(env,userId,workspaceId);
  const field = /SignUpInNewWorkspace/i.test(op) ? 'signUpInNewWorkspace' : 'signUpInWorkspace';
  return Response.json({data:{[field]:{
    loginToken:{token:session.id,expiresAt:session.expiresAt},
    workspace:{id:workspaceId,name:workspaceName,workspaceUrls:{subdomainUrl:new URL(request.url).origin,customUrl:null}},
  }}},{headers:{'cache-control':'no-store','set-cookie':nativeSessionCookie(session.id)}});
}
