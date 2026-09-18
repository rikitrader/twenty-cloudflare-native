import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { handleGraphql } from '../src/graphql-compat';
import { cleanupExpiredFileUploads, handleD1Crm } from '../src/d1-crm';
import type { Env } from '../src/types';
import { compatibilityId } from '../src/compatibility-id';

const workspace = '3914ed09-01ee-4cf7-88a9-34e42dd43c83';
const otherWorkspace = '50b1111d-fdc3-46a3-8b1b-99ef72f241b6';
const userId = '8db2f15d-6930-49d7-b1a0-3976fcd29959';
const subject = `user:${userId}`;
const session = 'local-authorization-regression-session';
const companyId = '78c0766f-4e65-42c0-bf38-ffbeb493d750';
const activityId = '0dc48d1c-cd1f-4754-8e57-c7e6f1c2525f';
const deletedActivityId = '69e564aa-64f9-4092-a3f1-e95d329cfe98';
const now = '2026-09-17T12:00:00.000Z';
let db: DatabaseSync;
let env: Env;
let storedObjects: Map<string, Uint8Array>;

beforeEach(() => {
  storedObjects = new Map();
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  const prepare = (sql: string) => ({ bind(...values: unknown[]) {
    const statement = db.prepare(sql);
    return {
      first: async () => statement.get(...values as never[]) ?? null,
      all: async () => ({ results: statement.all(...values as never[]) }),
      run: async () => ({ success: true, meta: statement.run(...values as never[]) }),
    };
  } });
  env = { ACCESS_REQUIRED: 'true', CRM_DB: { prepare, batch: async (statements: { run: () => Promise<unknown> }[]) => {
    db.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      db.exec('COMMIT');
      return results;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } }, STORAGE: {
    put: async (key: string, body: ReadableStream | ArrayBuffer | ArrayBufferView) => {
      const bytes = body instanceof ReadableStream
        ? new Uint8Array(await new Response(body).arrayBuffer())
        : body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      storedObjects.set(key, bytes);
      return { size: bytes.byteLength };
    },
    get: async (key: string) => {
      const bytes = storedObjects.get(key);
      return bytes ? { body: bytes } : null;
    },
    delete: async (key: string) => { storedObjects.delete(key); },
  } } as unknown as Env;
  for (const id of [workspace, otherWorkspace]) db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run(id, 'Authorization regression', now);
  db.prepare('INSERT INTO native_users (id,email,password_hash,password_salt,created_at,updated_at) VALUES (?,?,?,?,?,?)')
    .run(userId, 'authorization-regression@example.invalid', 'unused-session-test', 'unused-session-test', now, now);
  db.prepare("INSERT INTO workspace_members VALUES (?,?,'member','active',?)").run(workspace, subject, now);
  db.prepare('INSERT INTO native_sessions VALUES (?,?,?,?,?,?,NULL)')
    .run(session, workspace, subject, now, now, '2099-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO companies (id,workspace_id,name,created_at,updated_at) VALUES (?,?,?,?,?)')
    .run(companyId, workspace, 'Private company', now, now);
  for (const [id, title, deletedAt] of [[activityId, 'Private activity', null], [deletedActivityId, 'Trashed activity', now]]) {
    db.prepare('INSERT INTO activities (id,workspace_id,title,type,company_id,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, workspace, title, 'note', companyId, now, now, deletedAt);
  }
  db.prepare('INSERT INTO workspace_settings VALUES (?,?,?,?,?)').run(workspace, 'permissions', JSON.stringify({
    owner: { read: true, create: true, update: true, delete: true },
    member: { read: false, create: false, update: false, delete: false },
  }), now, subject);
});

afterEach(() => db.close());

const post = async (operationName: string, root: string, variables: Record<string, unknown> = {}, target = workspace) => {
  const response = (await handleGraphql(new Request('https://crm.example.test/graphql', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `twenty_session=${session}`, 'x-workspace-id': target },
    body: JSON.stringify({ operationName, query: `${/^(Delete|Create|Reset|Update)/.test(operationName) ? 'mutation' : 'query'} ${operationName} { ${root} { id } }`, variables }),
  }), env))!;
  return { status: response.status, body: await response.json() as Record<string, any> };
};

it.each([
  ['TimelineThreads', 'timelineThreads'],
  ['TimelineCalendarEvents', 'timelineCalendarEvents'],
])('enforces stored read denial for %s through the real authenticated resolver', async (op, root) => {
  const response = await post(op, root, { objectRecordId: companyId });
  expect(response.status).toBe(403);
  expect(response.body.data).toBeUndefined();
  expect(JSON.stringify(response.body)).not.toContain('Private activity');
});

it.each([
  ['TimelineThreads', 'timelineThreads'],
  ['TimelineCalendarEvents', 'timelineCalendarEvents'],
])('excludes soft-deleted activities and enforces membership for %s', async (op, root) => {
  db.prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND identity_subject=?").run(workspace, subject);
  const response = await post(op, root, { objectRecordId: companyId });
  expect(response.status).toBe(200);
  expect(response.body.data[root].map((row: Record<string, unknown>) => row.id)).toEqual([activityId]);
  expect((await post(op, root, { objectRecordId: companyId }, otherWorkspace)).status).toBe(403);
});

it('cannot bypass core permissions or trash behavior by renaming the operation', async () => {
  expect((await post('DeleteOneCompany', 'deleteCompany', { idToDelete: companyId })).status).toBe(403);
  for (const [operation, root] of [['DeleteCompany', 'deleteCompany'], ['FindCompany', 'company']]) {
    const response = await post(operation, root, { id: companyId });
    expect(response.status).toBe(400);
    expect(response.body.errors[0].extensions.code).toBe('UNSUPPORTED_OPERATION');
  }
  expect(db.prepare('SELECT name,deleted_at FROM companies WHERE id=?').get(companyId))
    .toMatchObject({ name: 'Private company', deleted_at: null });
});

it('fails closed on the legacy CRM REST surface for custom roles', async () => {
  db.prepare('INSERT INTO custom_roles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('sales', workspace, 'Sales', null, null, 0, 0, 1, 0, 0, 0, 1, 0, 0, now, now);
  db.prepare('INSERT INTO role_assignments VALUES (?,?,?,?,?)').run(workspace, subject, 'sales', now, now);
  const response = (await handleD1Crm(new Request('https://crm.example.test/api/crm/contacts', {
    headers: { cookie: `twenty_session=${session}`, 'x-workspace-id': workspace },
  }), env))!;
  expect(response.status).toBe(403);
  expect(await response.json()).toMatchObject({ error: expect.stringContaining('permission-aware GraphQL') });
});

it('denies member access to administrative REST resources and cross-tenant selection', async () => {
  const memberResponse = (await handleD1Crm(new Request('https://crm.example.test/api/crm/members', {
    headers: { cookie: `twenty_session=${session}`, 'x-workspace-id': workspace },
  }), env))!;
  expect(memberResponse.status).toBe(403);
  for (const path of ['/api/crm/exports/synthetic-export', '/api/crm/import/synthetic-import', '/api/crm/outbox']) {
    const response = (await handleD1Crm(new Request(`https://crm.example.test${path}`, {
      headers: { cookie: `twenty_session=${session}`, 'x-workspace-id': workspace },
    }), env))!;
    expect(response.status, path).toBe(403);
  }

  const crossTenantResponse = (await handleD1Crm(new Request('https://crm.example.test/api/crm/contacts', {
    headers: { cookie: `twenty_session=${session}`, 'x-workspace-id': otherWorkspace },
  }), env))!;
  expect(crossTenantResponse.status).toBe(403);
});

it('does not expose records through renamed search or chart compatibility branches', async () => {
  expect((await post('SearchCompany', 'search', { query: 'Private' })).status).toBe(403);
  expect((await post('BarChartData', 'barChartData', { objectName: 'opportunity' })).status).toBe(403);
});

it('cannot bypass navigation or metadata authorization through renamed mutations', async () => {
  const navigation = JSON.stringify([{ id: 'existing-navigation', name: 'Preserve this', position: 0 }]);
  db.prepare('INSERT INTO workspace_settings VALUES (?,?,?,?,?)').run(workspace, 'navigationMenuItems', navigation, now, subject);
  expect((await post('ResetNavigationMenuItems', 'navigationMenuItems')).status).toBe(400);
  expect((await post('CreateFieldMetadataItem', 'createOneField', {
    input: { objectType: 'contact', name: 'forbidden', label: 'Forbidden', type: 'text' },
  })).status).toBe(400);
  expect(db.prepare("SELECT value_json FROM workspace_settings WHERE workspace_id=? AND setting_key='navigationMenuItems'").get(workspace))
    .toMatchObject({ value_json: navigation });
  expect(db.prepare('SELECT COUNT(*) AS count FROM custom_fields').get()).toMatchObject({ count: 0 });
});

it.each(['UpdatePageLayout', 'ResetPageLayoutTabToDefault'])('rejects unsupported layout mutation %s without pretending to save', async operation => {
  const saved = JSON.stringify({ existing: { id: 'legacy-layout', name: 'Preserve legacy configuration', tabs: [] } });
  db.prepare('INSERT INTO workspace_settings VALUES (?,?,?,?,?)').run(workspace, 'pageLayouts', saved, now, subject);
  const result = await post(operation, 'updatePageLayoutWithTabsAndWidgets', {
    id: 'legacy-layout', input: { name: 'Unauthorized layout', tabs: [] },
  });
  expect(result.status).toBe(400);
  expect(result.body.data).toBeUndefined();
  expect(result.body.errors[0].extensions.code).toBe('UNSUPPORTED_OPERATION');
  expect(db.prepare("SELECT value_json FROM workspace_settings WHERE workspace_id=? AND setting_key='pageLayouts'").get(workspace))
    .toMatchObject({ value_json: saved });
  expect(db.prepare("SELECT COUNT(*) AS count FROM workspace_settings WHERE setting_key LIKE 'crm.layout:%'").get()).toMatchObject({ count: 0 });
});

it.each(['SignDpa', 'AcceptDpa', 'UpdateLegalAgreement', 'GenerateSignedDpa'])('keeps consequential legal action %s unavailable even to workspace owners', async operation => {
  db.prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND identity_subject=?").run(workspace, subject);
  const agreement = JSON.stringify({ version: 'unaccepted-test', accepted: false });
  db.prepare('INSERT INTO workspace_settings VALUES (?,?,?,?,?)').run(workspace, 'dpaAgreement', agreement, now, subject);
  const result = await post(operation, 'signDpa', { input: { accepted: true } });
  expect(result.status).toBe(403);
  expect(result.body.data).toBeUndefined();
  expect(db.prepare("SELECT value_json FROM workspace_settings WHERE workspace_id=? AND setting_key='dpaAgreement'").get(workspace))
    .toMatchObject({ value_json: agreement });
});

it.each([
  ['UpdateMessageFolders', 'updateMessageFolders'],
  ['UploadWorkspaceLogo', 'uploadWorkspaceLogo'],
  ['RetryChatMessage', 'retryChatMessage'],
  ['SendMessageCampaignTest', 'sendMessageCampaignTest'],
  ['GrantWorkspaceCredits', 'grantWorkspaceCredits'],
  ['SwitchBillingPlan', 'switchBillingPlan'],
  ['CheckCustomDomainValidRecords', 'checkCustomDomainValidRecords'],
  ['CreateSamlSsoIdentityProvider', 'createSamlSsoIdentityProvider'],
  ['InstallApplication', 'installApplication'],
  ['SendInvitations', 'sendInvitations'],
])('never returns synthetic success for unavailable operation %s', async (operation, root) => {
  db.prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND identity_subject=?").run(workspace, subject);
  const result = await post(operation, root, { input: { id: crypto.randomUUID() } });
  expect(result.status).toBe(501);
  expect(result.body.data).toBeUndefined();
  expect(result.body.errors[0].extensions.code).toMatch(/NOT_IMPLEMENTED|PROVIDER_NOT_CONFIGURED/);
});

it('persists and queues an authorized Workers AI chat message', async () => {
  db.prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND identity_subject=?").run(workspace, subject);
  const threadId=crypto.randomUUID();const messageId=crypto.randomUUID();const queued:unknown[]=[];
  db.prepare('INSERT INTO ai_chat_threads VALUES (?,?,?,?,?,?,?)').run(threadId,workspace,'Chat','active',subject,now,now);
  env.AI={run:async()=>({response:'ok'})} as never;
  env.JOBS_QUEUE={send:async(value:unknown)=>{queued.push(value);}} as never;
  const result=await post('SendChatMessage','sendChatMessage',{threadId,text:'Review this account',messageId});
  expect(result.status).toBe(202);
  expect(result.body.data.sendChatMessage).toMatchObject({messageId,queued:true,threadId});
  expect(db.prepare('SELECT role,content FROM ai_chat_messages WHERE id=? AND workspace_id=?').get(messageId,workspace)).toEqual({role:'user',content:'Review this account'});
  expect(queued).toHaveLength(1);
  expect(queued[0]).toMatchObject({jobName:'ai.chat',data:{workspaceId:workspace,threadId,messageId}});
});

it('creates usable workspace-bound API keys with role enforcement and revocation', async () => {
  db.prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND identity_subject=?").run(workspace, subject);
  db.prepare("UPDATE workspace_settings SET value_json=? WHERE workspace_id=? AND setting_key='permissions'")
    .run(JSON.stringify({
      owner: { read: true, create: true, update: true, delete: true },
      admin: { read: true, create: true, update: true, delete: true },
      member: { read: true, create: false, update: false, delete: false },
    }), workspace);
  const created = await post('CreateApiKey', 'createApiKey', { input: { name: 'Read-only integration' } });
  expect(created.status).toBe(200);
  const key = created.body.data.createApiKey as { id: string; token: string; role: string };
  expect(key.token).toMatch(/^twenty_[A-Za-z0-9]{32,128}$/);
  expect(key.role).toBe('member');

  const apiPost = async (target: string) => {
    const response = (await handleGraphql(new Request('https://crm.example.test/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key.token}`, 'x-workspace-id': target },
      body: JSON.stringify({ operationName: 'FindManyCompanies', query: 'query FindManyCompanies { companies { nodes { id } } }' }),
    }), env))!;
    return { status: response.status, body: await response.json() as Record<string, any> };
  };

  const allowed = await apiPost(workspace);
  expect(allowed.status).toBe(200);
  expect(allowed.body.data.companies.nodes).toHaveLength(1);
  expect(db.prepare('SELECT last_used_at FROM native_api_keys WHERE id=?').get(key.id)?.last_used_at).toBeTruthy();
  expect((await apiPost(otherWorkspace)).status).toBe(403);

  const assigned = await post('AssignRoleToApiKey', 'assignRoleToApiKey', { input: { apiKeyId: key.id, roleId: 'admin' } });
  expect(assigned.status).toBe(200);
  expect(assigned.body.data.assignRoleToApiKey).toMatchObject({ id: key.id, role: 'admin' });
  expect(db.prepare('SELECT role FROM native_api_keys WHERE id=?').get(key.id)).toMatchObject({ role: 'admin' });

  expect((await post('RevokeApiKey', 'revokeApiKey', { apiKeyId: key.id })).status).toBe(200);
  const revoked = await apiPost(workspace);
  expect(revoked.status).toBe(200);
  expect(revoked.body).toEqual({errors:[{message:'unauthorized',extensions:{code:'UNAUTHENTICATED'}}]});
});

it('only completes a file upload after an authorized R2 metadata commit exists', async () => {
  db.prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND identity_subject=?").run(workspace, subject);
  const missing = await post('CompleteFileUpload', 'completeFileUpload', { input: { fileId: crypto.randomUUID() } });
  expect(missing.status).toBe(404);
  const fileId = crypto.randomUUID();
  db.prepare('INSERT INTO crm_files (id,workspace_id,object_key,filename,content_type,bytes,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(fileId, workspace, `${workspace}/${fileId}`, 'evidence.txt', 'text/plain', 8, now);
  const committed = await post('CompleteFileUpload', 'completeFileUpload', { input: { fileId } });
  expect(committed.status).toBe(200);
  expect(committed.body.data.completeFileUpload).toMatchObject({ id: fileId, size: 8, url: `/api/crm/files/${fileId}` });
  const other = await post('CompleteFileUpload', 'completeFileUpload', { input: { fileId } }, otherWorkspace);
  expect(other.status).toBe(403);
});

it('creates an expiring single-use direct upload target with the exact Twenty contract', async () => {
  db.prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND identity_subject=?").run(workspace, subject);
  const created = await post('CreateFileUpload', 'createFileUpload', {
    filename: 'evidence.pdf', size: 128, fileFolder: 'Attachment', fieldMetadataId: null,
  });
  expect(created.status).toBe(200);
  expect(created.body.data.createFileUpload).toMatchObject({ contentType: 'application/pdf' });
  expect(created.body.data.createFileUpload.fileId).toBeTypeOf('string');
  const uploadUrl = new URL(created.body.data.createFileUpload.uploadUrl);
  expect(uploadUrl.pathname).toBe(`/api/crm/file-uploads/${created.body.data.createFileUpload.fileId}`);
  expect(uploadUrl.searchParams.get('token')).toHaveLength(68);
  expect(db.prepare('SELECT workspace_id,status,expected_bytes FROM pending_file_uploads WHERE id=?').get(created.body.data.createFileUpload.fileId))
    .toMatchObject({ workspace_id: workspace, status: 'pending', expected_bytes: 128 });
  expect(db.prepare('SELECT token_hash FROM pending_file_uploads WHERE id=?').get(created.body.data.createFileUpload.fileId)?.token_hash)
    .not.toBe(uploadUrl.searchParams.get('token'));
});

it('commits, downloads, denies, cleans up, and rejects replay of direct R2 uploads', async () => {
  db.prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND identity_subject=?").run(workspace, subject);
  const created = await post('CreateFileUpload', 'createFileUpload', {
    filename: 'evidence.txt', size: 8, fileFolder: 'Attachment', fieldMetadataId: null,
  });
  const target = created.body.data.createFileUpload as { fileId: string; uploadUrl: string; contentType: string };
  const upload = (await handleD1Crm(new Request(target.uploadUrl, {
    method: 'PUT', headers: { 'content-type': target.contentType, 'content-length': '8' }, body: 'evidence',
  }), env))!;
  expect(upload.status).toBe(204);
  expect(db.prepare('SELECT status FROM pending_file_uploads WHERE id=?').get(target.fileId)).toMatchObject({ status: 'uploaded' });
  expect(db.prepare('SELECT bytes FROM crm_files WHERE id=?').get(target.fileId)).toMatchObject({ bytes: 8 });

  const replay = (await handleD1Crm(new Request(target.uploadUrl, {
    method: 'PUT', headers: { 'content-type': target.contentType, 'content-length': '8' }, body: 'evidence',
  }), env))!;
  expect(replay.status).toBe(410);
  expect(db.prepare('SELECT COUNT(*) AS count FROM crm_files WHERE id=?').get(target.fileId)).toMatchObject({ count: 1 });

  const committed = await post('CompleteFileUpload', 'completeFileUpload', { fileId: target.fileId });
  expect(committed.status).toBe(200);
  const download = (await handleD1Crm(new Request(`https://crm.example.test/api/crm/files/${target.fileId}`, {
    headers: { cookie: `twenty_session=${session}`, 'x-workspace-id': workspace },
  }), env))!;
  expect(download.status).toBe(200);
  expect(await download.text()).toBe('evidence');

  db.prepare("UPDATE workspace_members SET role='member' WHERE workspace_id=? AND identity_subject=?").run(workspace, subject);
  expect((await handleD1Crm(new Request(`https://crm.example.test/api/crm/files/${target.fileId}`, {
    headers: { cookie: `twenty_session=${session}`, 'x-workspace-id': workspace },
  }), env))!.status).toBe(403);
  expect((await handleD1Crm(new Request(`https://crm.example.test/api/crm/files/${target.fileId}`, {
    headers: { cookie: `twenty_session=${session}`, 'x-workspace-id': otherWorkspace },
  }), env))!.status).toBe(403);

  db.prepare("UPDATE pending_file_uploads SET status='failed', expires_at=? WHERE id=?").run('2020-01-01T00:00:00.000Z', target.fileId);
  await cleanupExpiredFileUploads(env);
  expect(db.prepare('SELECT status FROM pending_file_uploads WHERE id=?').get(target.fileId)).toMatchObject({ status: 'expired' });
  expect(storedObjects.size).toBe(0);
});

it('records R2 upload failures without creating file metadata', async () => {
  db.prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND identity_subject=?").run(workspace, subject);
  const created = await post('CreateFileUpload', 'createFileUpload', {
    filename: 'failure.txt', size: 4, fileFolder: 'Attachment', fieldMetadataId: null,
  });
  const target = created.body.data.createFileUpload as { fileId: string; uploadUrl: string; contentType: string };
  env.STORAGE.put = async () => { throw new Error('simulated R2 failure'); };
  const result = (await handleD1Crm(new Request(target.uploadUrl, {
    method: 'PUT', headers: { 'content-type': target.contentType, 'content-length': '4' }, body: 'fail',
  }), env))!;
  expect(result.status).toBe(500);
  expect(db.prepare('SELECT status FROM pending_file_uploads WHERE id=?').get(target.fileId)).toMatchObject({ status: 'failed' });
  expect(db.prepare('SELECT COUNT(*) AS count FROM crm_files WHERE id=?').get(target.fileId)).toMatchObject({ count: 0 });
});

it('implements the Twenty attachment record workflow over committed R2 files', async () => {
  db.prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND identity_subject=?").run(workspace, subject);
  const attachmentObjectId = await compatibilityId(`object:${workspace}:attachment`);
  const attachmentFileFieldId = await compatibilityId(`field:${attachmentObjectId}:file`);
  const target = await post('CreateFileUpload', 'createFileUpload', {
    filename: 'contract.pdf', size: 7, fileFolder: 'FilesField', fieldMetadataId: attachmentFileFieldId,
  });
  expect(target.status).toBe(200);
  const upload = target.body.data.createFileUpload as { fileId: string; uploadUrl: string; contentType: string };
  expect((await handleD1Crm(new Request(upload.uploadUrl, {
    method: 'PUT', headers: { 'content-type': upload.contentType, 'content-length': '7' }, body: 'pdfdata',
  }), env))!.status).toBe(204);

  const created = await post('CreateOneAttachment', 'createOneAttachment', { input: {
    name: 'contract.pdf', targetCompanyId: companyId, file: [{ fileId: upload.fileId, label: 'contract.pdf' }],
  } });
  expect(created.status).toBe(200);
  const attachment = created.body.data.createOneAttachment;
  expect(attachment).toMatchObject({ name: 'contract.pdf', targetCompanyId: companyId });
  expect(attachment.file[0]).toMatchObject({ fileId: upload.fileId, extension: '.pdf', url: `/api/crm/files/${upload.fileId}` });
  expect(db.prepare('SELECT record_type,record_id FROM crm_file_links WHERE file_id=?').get(upload.fileId))
    .toMatchObject({ record_type: 'company', record_id: companyId });

  const listed = await post('FindManyAttachments', 'attachments', { filter: { targetCompanyId: { eq: companyId } } });
  expect(listed.status).toBe(200);
  expect(listed.body.data.attachments.nodes).toHaveLength(1);

  const renamed = await post('UpdateOneAttachment', 'updateOneAttachment', {
    idToUpdate: attachment.id, input: { name: 'signed-contract.pdf', file: [{ fileId: upload.fileId, label: 'signed-contract.pdf' }] },
  });
  expect(renamed.status).toBe(200);
  expect(renamed.body.data.updateOneAttachment.name).toBe('signed-contract.pdf');
  expect((await post('DeleteOneAttachment', 'deleteOneAttachment', { idToDelete: attachment.id })).status).toBe(200);
  expect((await post('RestoreOneAttachment', 'restoreOneAttachment', { idToRestore: attachment.id })).status).toBe(200);
  expect((await post('DeleteOneAttachment', 'deleteOneAttachment', { idToDelete: attachment.id })).status).toBe(200);
  expect((await post('DestroyOneAttachment', 'destroyOneAttachment', { idToDestroy: attachment.id })).status).toBe(200);
  expect(db.prepare('SELECT COUNT(*) AS count FROM crm_attachments WHERE id=?').get(attachment.id)).toMatchObject({ count: 0 });
  expect((await post('FindManyAttachments', 'attachments', { filter: { targetCompanyId: { eq: companyId } } })).body.data.attachments.nodes).toHaveLength(0);

  const authHeaders = { cookie: `twenty_session=${session}`, 'x-workspace-id': workspace };
  const links = (await handleD1Crm(new Request(`https://crm.example.test/api/crm/file-links?recordType=company&recordId=${companyId}`, { headers: authHeaders }), env))!;
  expect(links.status).toBe(200);
  expect((await links.json() as any).data).toHaveLength(1);
  expect((await handleD1Crm(new Request(`https://crm.example.test/api/crm/file-links/${upload.fileId}?recordType=company&recordId=${companyId}`, {
    method: 'DELETE', headers: authHeaders,
  }), env))!.status).toBe(204);
  expect((await handleD1Crm(new Request(`https://crm.example.test/api/crm/files/${upload.fileId}`, {
    method: 'DELETE', headers: authHeaders,
  }), env))!.status).toBe(204);
  expect(storedObjects.size).toBe(0);
  expect(db.prepare('SELECT COUNT(*) AS count FROM crm_files WHERE id=?').get(upload.fileId)).toMatchObject({ count: 0 });
});

it('implements exact task/note target contracts with atomic audit and outbox rows', async () => {
  db.prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND identity_subject=?").run(workspace, subject);
  const taskResult = await post('CreateOneTask', 'createOneTask', { input: {
    title: 'Call the constituent', bodyV2: { blocknote: '[{"type":"paragraph"}]', markdown: null }, status: 'TODO', position: 'last',
  } });
  expect(taskResult.status).toBe(200);
  const task = taskResult.body.data.createOneTask;
  expect(task).toMatchObject({ __typename: 'Task', title: 'Call the constituent', status: 'TODO' });

  const noteResult = await post('CreateOneNote', 'createOneNote', { input: {
    title: 'Meeting note', bodyV2: { blocknote: '[{"type":"paragraph"}]', markdown: 'Met at city hall.' }, position: 'last',
  } });
  expect(noteResult.status).toBe(200);
  const note = noteResult.body.data.createOneNote;
  expect(note).toMatchObject({ __typename: 'Note', title: 'Meeting note', bodyV2: { markdown: 'Met at city hall.' } });

  const linkedTasks = await post('CreateManyTaskTargets', 'createManyTaskTargets', { input: [{ taskId: task.id, targetCompanyId: companyId }] });
  expect(linkedTasks.status).toBe(200);
  expect(linkedTasks.body.data.createManyTaskTargets[0]).toMatchObject({ taskId: task.id, targetCompanyId: companyId });
  const linkedNotes = await post('CreateManyNoteTargets', 'createManyNoteTargets', { input: [{ noteId: note.id, targetCompanyId: companyId }] });
  expect(linkedNotes.status).toBe(200);

  const listed = await post('FindManyTaskTargets', 'taskTargets', { filter: { or: [{ targetCompanyId: { eq: companyId } }] } });
  expect(listed.status).toBe(200);
  expect(listed.body.data.taskTargets.nodes[0].task).toMatchObject({ id: task.id, status: 'TODO' });
  const completed = await post('UpdateOneTask', 'updateOneTask', { idToUpdate: task.id, input: { status: 'DONE' } });
  expect(completed.status).toBe(200);
  expect(completed.body.data.updateOneTask.status).toBe('DONE');

  expect(db.prepare("SELECT COUNT(*) AS count FROM crm_audit_events WHERE workspace_id=? AND object_type IN ('task','note','taskTarget','noteTarget')").get(workspace)).toMatchObject({ count: 5 });
  expect(db.prepare("SELECT COUNT(*) AS count FROM crm_event_outbox WHERE workspace_id=? AND object_type IN ('task','note','taskTarget','noteTarget') AND status='pending'").get(workspace)).toMatchObject({ count: 5 });
  expect((await post('FindManyTaskTargets', 'taskTargets', { filter: { or: [{ targetCompanyId: { eq: companyId } }] } }, otherWorkspace)).status).toBe(403);
});

it('does not let members configure webhooks, API keys, or provider accounts', async () => {
  for (const [operation, root, input] of [
    ['CreateWebhook', 'createWebhook', { url: 'https://example.invalid/hook' }],
    ['CreateApiKey', 'createApiKey', { name: 'forbidden' }],
    ['SaveImapSmtpCaldavAccount', 'saveImapSmtpCaldavAccount', { name: 'forbidden' }],
  ] as const) {
    const result = await post(operation, root, { input });
    expect(result.status).toBe(403);
  }
  expect(db.prepare('SELECT COUNT(*) AS count FROM native_webhooks').get()).toMatchObject({ count: 0 });
  expect(db.prepare('SELECT COUNT(*) AS count FROM native_api_keys').get()).toMatchObject({ count: 0 });
  expect(db.prepare('SELECT COUNT(*) AS count FROM integration_accounts').get()).toMatchObject({ count: 0 });
});

it('validates and authorizes exact dynamic custom-object record contracts', async () => {
  const objectId = crypto.randomUUID();
  const fieldId = crypto.randomUUID();
  db.prepare('INSERT INTO custom_objects (id,workspace_id,object_key,label,plural_label,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(objectId, workspace, 'petition', 'Petition', 'Petitions', now, now);
  db.prepare('INSERT INTO custom_fields (id,workspace_id,object_type,field_key,label,field_type,is_nullable,is_unique,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(fieldId, workspace, 'petition', 'headline', 'Headline', 'text', 0, 1, now);
  expect((await post('CreateOnePetition', 'createOnePetition', { input: { headline: 'Protect the park' } })).status).toBe(403);
  db.prepare("UPDATE workspace_members SET role='owner' WHERE workspace_id=? AND identity_subject=?").run(workspace, subject);
  expect((await post('CreateOnePetition', 'createOnePetition', { input: {} })).status).toBe(400);
  const created = await post('CreateOnePetition', 'createOnePetition', { input: { headline: 'Protect the park' } });
  expect(created.status).toBe(200);
  expect(created.body.data.createOnePetition).toMatchObject({ headline: 'Protect the park' });
  expect((await post('CreateOnePetition', 'createOnePetition', { input: { headline: 'Protect the park' } })).status).toBe(409);
  const listed = await post('FindManyPetitions', 'petitions');
  expect(listed.status).toBe(200);
  expect(listed.body.data.petitions.nodes).toHaveLength(1);
});
