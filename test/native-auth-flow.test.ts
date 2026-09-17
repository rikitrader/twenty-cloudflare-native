import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { handleGraphql } from '../src/graphql-compat';
import type { Env } from '../src/types';

let db: DatabaseSync;
let env: Env;
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(name=>name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  const prepare = (sql: string) => ({ bind(...values: unknown[]) {
    const statement = db.prepare(sql);
    return {
      first: async () => statement.get(...values as never[]) ?? null,
      all: async () => ({ results: statement.all(...values as never[]) }),
      run: async () => ({ success:true, meta:statement.run(...values as never[]) }),
    };
  } });
  env = { ACCESS_REQUIRED:'true', CRM_DB:{ prepare, batch:async (statements: {run:()=>Promise<unknown>}[]) => {
    db.exec('BEGIN');
    try { const results = []; for (const s of statements) results.push(await s.run()); db.exec('COMMIT'); return results; }
    catch(error) { db.exec('ROLLBACK'); throw error; }
  } } } as unknown as Env;
});
afterEach(() => db.close());

const post = (operationName: string, query: string, variables: Record<string, unknown>, cookie?:string, workspaceId?:string) => handleGraphql(new Request('https://crm.example.test/metadata', {
  method:'POST', headers:{'content-type':'application/json', ...(cookie ? {cookie}:{}), ...(workspaceId ? {'x-workspace-id':workspaceId}:{})},
  body:JSON.stringify({operationName,query,variables}),
}), env);
const signup = () => post('SignUpInNewWorkspace', 'mutation SignUpInNewWorkspace { signUpInNewWorkspace { loginToken { token expiresAt __typename } workspace { id workspaceUrls { subdomainUrl __typename } __typename } __typename } }', {email:'native-test@example.invalid', password:'Local regression test 123!'});

it('persists signup, accepts the correct password, and establishes an authorized session with Apollo fields', async () => {
  const created = (await signup())!;
  expect(created.status).toBe(200);
  const cookie = created.headers.get('set-cookie')!.split(';')[0];
  expect(created.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax');
  expect(created.headers.get('set-cookie')).toContain('Max-Age=604800');
  const persistedSession = db.prepare('SELECT created_at AS createdAt, expires_at AS expiresAt FROM native_sessions LIMIT 1').get() as {createdAt:string;expiresAt:string};
  expect(Date.parse(persistedSession.expiresAt) - Date.parse(persistedSession.createdAt)).toBe(7 * 24 * 60 * 60 * 1000);
  expect((db.prepare('SELECT COUNT(*) AS count FROM native_users').get() as {count:number}).count).toBe(1);
  const current = (await post('GetCurrentUser', 'query GetCurrentUser { currentUser { id email __typename } }', {}, cookie))!;
  expect(current.status).toBe(200);
  expect(await current.json()).toMatchObject({data:{currentUser:{email:'native-test@example.invalid'}}});
  const login = (await post('GetLoginTokenFromCredentials', 'mutation GetLoginTokenFromCredentials { getLoginTokenFromCredentials { loginToken { token expiresAt __typename } __typename } }', {email:'native-test@example.invalid',password:'Local regression test 123!'}))!;
  expect(login.status).toBe(200);
  expect(await login.json()).toMatchObject({data:{getLoginTokenFromCredentials:{loginToken:{token:expect.any(String)}}}});
});

it('renews, selectively revokes, and signs out native sessions without false success', async () => {
  const created = (await signup())!;
  const firstCookie = created.headers.get('set-cookie')!.split(';')[0];
  const login = (await post('GetLoginTokenFromCredentials', 'mutation GetLoginTokenFromCredentials { getLoginTokenFromCredentials { loginToken { token } } }', {email:'native-test@example.invalid',password:'Local regression test 123!'}))!;
  const secondCookie = login.headers.get('set-cookie')!.split(';')[0];
  expect((db.prepare('SELECT COUNT(*) AS count FROM native_sessions WHERE revoked_at IS NULL').get() as {count:number}).count).toBe(2);

  const sessionsResponse=(await post('GetCurrentUserSessions','query GetCurrentUserSessions { currentUserSessions { id createdAt lastActiveAt isCurrent userAgent ipAddress __typename } }',{},firstCookie))!;
  const sessionsBody=await sessionsResponse.json() as any;
  expect(sessionsBody.data.currentUserSessions).toHaveLength(2);
  expect(sessionsBody.data.currentUserSessions.every((session:any)=>Number.isFinite(Date.parse(session.lastActiveAt)))).toBe(true);
  expect(sessionsBody.data.currentUserSessions.filter((session:any)=>session.isCurrent)).toHaveLength(1);

  const renewed = (await post('RenewToken', 'mutation RenewToken { renewToken { accessToken { token expiresAt } } }', {}, firstCookie))!;
  expect(renewed.status).toBe(200);
  expect(await renewed.json()).toMatchObject({data:{renewToken:{accessToken:{token:firstCookie.split('=')[1]}}}});

  const revoked = (await post('RevokeAllOtherUserSessions', 'mutation RevokeAllOtherUserSessions { revokeAllOtherUserSessions { success } }', {}, firstCookie))!;
  expect(revoked.status).toBe(200);
  expect((db.prepare('SELECT COUNT(*) AS count FROM native_sessions WHERE revoked_at IS NULL').get() as {count:number}).count).toBe(1);
  const revokedSession = (await post('GetCurrentUser', 'query GetCurrentUser { currentUser { id } }', {}, secondCookie))!;
  expect(revokedSession.status).toBe(200);
  expect(await revokedSession.json()).toEqual({data:{currentUser:null,me:null}});

  const signedOut = (await post('SignOut', 'mutation SignOut { signOut { success } }', {}, firstCookie))!;
  expect(signedOut.status).toBe(200);
  expect(signedOut.headers.get('set-cookie')).toContain('Max-Age=0');
  expect((db.prepare('SELECT COUNT(*) AS count FROM native_sessions WHERE revoked_at IS NULL').get() as {count:number}).count).toBe(0);
  const afterSignOut = (await post('GetCurrentUser', 'query GetCurrentUser { currentUser { id } }', {}, firstCookie))!;
  expect(afterSignOut.status).toBe(200);
  expect(await afterSignOut.json()).toEqual({data:{currentUser:null,me:null}});
});

it('rejects wrong passwords and cross-workspace session access with __typename present', async () => {
  const created = (await signup())!;
  const cookie = created.headers.get('set-cookie')!.split(';')[0];
  const wrong = (await post('GetLoginTokenFromCredentials', 'mutation GetLoginTokenFromCredentials { getLoginTokenFromCredentials { loginToken { token __typename } } }', {email:'native-test@example.invalid',password:'Wrong password'}))!;
  expect(wrong.status).toBe(401);
  const other = (await post('FindManyPeople', 'query FindManyPeople { people { id __typename } }', {}, cookie, 'another-workspace'))!;
  expect(other.status).toBe(403);
});

it('does not confuse current-user nested metadata fragments with metadata operations', async () => {
  const created = (await signup())!;
  const cookie = created.headers.get('set-cookie')!.split(';')[0];
  const response = (await post('GetCurrentUser', 'query GetCurrentUser { currentUser { id __typename } } fragment FieldMetadataItem on Field { id __typename }', {}, cookie))!;
  const body = await response.json() as any;
  expect(body.data.currentUser.__typename).toBe('User');
  expect(body.data.currentUser.availableWorkspaces.availableWorkspacesForSignIn).toHaveLength(1);
  expect(body.data.currentUser.currentWorkspace.workspaceUrls.subdomainUrl).toBe('https://crm.example.test');
  expect(body.data.objectMetadataItems).toBeUndefined();
});

it('returns authenticated metadata connections and checks workspace membership before every bootstrap operation', async () => {
  const created = (await signup())!;
  const cookie = created.headers.get('set-cookie')!.split(';')[0];
  const query = 'query ObjectMetadataItems { objects { edges { node { id __typename } } } }';
  const response = (await post('ObjectMetadataItems', query, {}, cookie))!;
  const body = await response.json() as any;
  expect(body.data.objects.edges.filter(({node}:any)=>!node.isSystem)).toHaveLength(4);
  for (const {node} of body.data.objects.edges.filter(({node}:any)=>!node.isSystem)) {
    expect(node.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(node.__typename).toBe('Object');
    expect(node.isSystem).toBe(false);
  }
  for (const op of ['ObjectMetadataItems','FindMinimalMetadata','GetCurrentUser','FindAllViews','FindAllRecordPageLayouts','FindManyLogicFunctions']) {
    expect((await post(op, `query ${op} { example { __typename } }`, {}, cookie, 'another-workspace'))!.status).toBe(403);
  }
  const unauthenticated = (await post('ObjectMetadataItems', query, {}))!;
  expect(unauthenticated.status).toBe(200);
  expect(await unauthenticated.json()).toEqual({errors:[{message:'unauthorized',extensions:{code:'UNAUTHENTICATED'}}]});
});

it('acknowledges disabled analytics without persisting data or bypassing protected CRM operations', async () => {
  const response = (await post('TrackAnalytics', 'mutation TrackAnalytics { trackAnalytics { success __typename } }', {}))!;
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({data:{trackAnalytics:{__typename:'Analytics',success:false}}});
  expect(db.prepare('SELECT COUNT(*) AS count FROM crm_audit_events').get()).toMatchObject({count:0});
  const protectedResponse = (await post('FindManyPeople', 'query FindManyPeople { people { id } }', {}))!;
  expect(protectedResponse.status).toBe(200);
  expect(await protectedResponse.json()).toEqual({errors:[{message:'unauthorized',extensions:{code:'UNAUTHENTICATED'}}]});
});

it('resolves the current workspace member using the actual generated objectRecordId variable', async () => {
  const created=(await signup())!;
  const cookie=created.headers.get('set-cookie')!.split(';')[0];
  const current=await (await post('GetCurrentUser','query GetCurrentUser { currentUser { id } }',{},cookie))!.json() as any;
  const id=current.data.currentUser.workspaceMember.id;
  const response=(await post('FindOneWorkspaceMember','query FindOneWorkspaceMember($objectRecordId:UUID!) { workspaceMember(filter:{id:{eq:$objectRecordId}}) { id userEmail } }',{objectRecordId:id},cookie))!;
  expect(await response.json()).toMatchObject({data:{workspaceMember:{id,userEmail:'native-test@example.invalid'}}});
  expect((await post('FindOneWorkspaceMember','query FindOneWorkspaceMember { workspaceMember { id } }',{objectRecordId:id},cookie,'foreign-workspace'))!.status).toBe(403);
});

it('cannot join an existing workspace by supplying its ID', async () => {
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run('protected','Protected','2026-01-01');
  const response = (await post('SignUpInWorkspace', 'mutation SignUpInWorkspace { signUpInWorkspace { loginToken { token __typename } } }', {workspaceId:'protected',email:'attacker@example.invalid',password:'Local regression test 123!'}))!;
  expect(response.status).toBe(403);
  expect(db.prepare('SELECT * FROM native_users').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM workspace_members').all()).toEqual([]);
});

const invite = async (status='pending') => {
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run('invited','Invited','2026-01-01');
  const token = crypto.randomUUID();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)))].map(b=>b.toString(16).padStart(2,'0')).join('');
  db.prepare('INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('invitation','invited','invited@example.invalid','member',hash,status,new Date(Date.now()+60000).toISOString(),'2026-01-01');
  return token;
};

it('joins only the invited workspace with the invited member role, never owner', async () => {
  const token = await invite();
  const vars = {email:'invited@example.invalid',password:'Local regression test 123!',workspacePersonalInviteToken:token};
  const response = (await post('SignUpInWorkspace', 'mutation SignUpInWorkspace { signUpInWorkspace { loginToken { token __typename } } }', vars))!;
  expect(response.status).toBe(200);
  expect(db.prepare('SELECT workspace_id,role FROM workspace_members').all()).toEqual([{workspace_id:'invited',role:'member'}]);
  expect(db.prepare('SELECT status FROM workspace_invitations').get()).toMatchObject({status:'accepted'});
  expect((await post('SignUpInWorkspace', 'mutation SignUpInWorkspace { signUpInWorkspace { __typename } }', vars))!.status).toBe(403);
});

it.each(['wrong-email','wrong-workspace','revoked','expired'])('rejects an invitation with %s', async mode => {
  const token = await invite(mode === 'revoked' ? 'revoked' : 'pending');
  if (mode === 'expired') db.prepare("UPDATE workspace_invitations SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  const response = (await post('SignUpInWorkspace', 'mutation SignUpInWorkspace { signUpInWorkspace { __typename } }', {
    email: mode === 'wrong-email' ? 'another@example.invalid' : 'invited@example.invalid',
    workspaceId:mode === 'wrong-workspace' ? 'other' : 'invited',
    password:'Local regression test 123!',workspacePersonalInviteToken:token,
  }))!;
  expect(response.status).toBe(403);
  expect(db.prepare('SELECT * FROM native_users').all()).toEqual([]);
});

it('rolls back registration if the invitation is revoked between lookup and commit', async () => {
  const token = await invite();
  const batch = env.CRM_DB!.batch.bind(env.CRM_DB);
  env.CRM_DB!.batch = async statements => {
    db.prepare("UPDATE workspace_invitations SET status = 'revoked'").run();
    return batch(statements);
  };
  const response = (await post('SignUpInWorkspace', 'mutation SignUpInWorkspace { signUpInWorkspace { __typename } }', {email:'invited@example.invalid',password:'Local regression test 123!',workspacePersonalInviteToken:token}))!;
  expect(response.status).toBe(409);
  expect(db.prepare('SELECT * FROM native_users').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM workspace_members').all()).toEqual([]);
});
