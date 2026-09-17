import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { handleGraphql } from '../src/graphql-compat';
import { compatibilityId } from '../src/compatibility-id';
import type { Env } from '../src/types';

const workspace = '130b79fe-55bd-4f85-9175-d2358fc90131';
const user = 'ca662c3d-9ed8-4a7f-aacc-baa49aaa9084';
const subject = `user:${user}`;
const session = 'custom-role-session';
const now = '2026-09-17T12:00:00.000Z';
let db: DatabaseSync;
let env: Env;

beforeEach(() => {
  db = new DatabaseSync(':memory:'); db.exec('PRAGMA foreign_keys = ON');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const prepare = (sql: string) => ({ bind(...values: unknown[]) { const statement = db.prepare(sql); return { first: async () => statement.get(...values as never[]) ?? null, all: async () => ({ results: statement.all(...values as never[]) }), run: async () => ({ success: true, meta: statement.run(...values as never[]) }) }; } });
  env = { ACCESS_REQUIRED: 'true', CRM_DB: { prepare, batch: async (statements: {run:()=>Promise<unknown>}[]) => { db.exec('BEGIN'); try { const output=[]; for(const statement of statements) output.push(await statement.run()); db.exec('COMMIT'); return output; } catch(error){db.exec('ROLLBACK');throw error;} } } } as unknown as Env;
  db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run(workspace,'Roles test',now);
  db.prepare('INSERT INTO native_users (id,email,password_hash,password_salt,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(user,'roles@example.invalid','x','x',now,now);
  db.prepare("INSERT INTO workspace_members VALUES (?,?,'owner','active',?)").run(workspace,subject,now);
  db.prepare('INSERT INTO native_sessions VALUES (?,?,?,?,?,?,NULL)').run(session,workspace,subject,now,now,'2099-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO contacts (id,workspace_id,first_name,last_name,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(crypto.randomUUID(),workspace,'Hidden','Person',now,now);
});

afterEach(() => db.close());

async function post(operationName: string, root: string, variables: Record<string,unknown> = {}) {
  const response = (await handleGraphql(new Request('https://crm.example.test/graphql',{method:'POST',headers:{'content-type':'application/json',cookie:`twenty_session=${session}`,'x-workspace-id':workspace},body:JSON.stringify({operationName,query:`mutation ${operationName} { ${root} { id } }`,variables})}),env))!;
  return {status:response.status,body:await response.json() as Record<string,any>};
}

it('creates, updates, lists, assigns, and enforces a custom object role', async () => {
  const roleId = '2e83729a-fd53-49b8-a5ef-d9958a3170b7';
  const created = await post('CreateOneRole','createOneRole',{createRoleInput:{id:roleId,label:'Restricted reader',canReadAllObjectRecords:true,canBeAssignedToUsers:true}});
  expect(created.status).toBe(200); expect(created.body.data.createOneRole).toMatchObject({id:roleId,label:'Restricted reader',isEditable:true});
  const updated = await post('UpdateOneRole','updateOneRole',{updateRoleInput:{id:roleId,update:{description:'Limited CRM visibility'}}});
  expect(updated.body.data.updateOneRole.description).toBe('Limited CRM visibility');
  const objectMetadataId = await compatibilityId(`object:${workspace}:person`);
  const permission = await post('UpsertObjectPermissions','upsertObjectPermissions',{upsertObjectPermissionsInput:{roleId,objectPermissions:[{objectMetadataId,canReadObjectRecords:false,canUpdateObjectRecords:false,canSoftDeleteObjectRecords:false,canDestroyObjectRecords:false}]}});
  expect(permission.status).toBe(200);
  const memberId = await compatibilityId(`member:${workspace}:${subject}`);
  const assignment = await post('UpdateWorkspaceMemberRole','updateWorkspaceMemberRole',{workspaceMemberId:memberId,roleId});
  expect(assignment.status).toBe(200); expect(assignment.body.data.updateWorkspaceMemberRole.roles[0].id).toBe(roleId);
  const denied = await post('FindManyPeople','people',{});
  expect(denied.status).toBe(403); expect(denied.body.errors[0].message).toContain('Not authorized');
  const searchDenied=await post('Search','search',{searchInput:'Hidden',includedObjectNameSingulars:['person']});
  expect(searchDenied.status).toBe(403);
});

it('keeps built-in roles immutable', async () => {
  const response = await post('UpdateOneRole','updateOneRole',{updateRoleInput:{id:'owner',update:{label:'Changed'}}});
  expect(response.status).toBe(400); expect(response.body.errors[0].message).toContain('immutable');
});

it('persists permission flags and agent role assignments with exact generated mutations', async () => {
  const roleId='4ef4fe8e-8e78-46ff-9a2f-3e130bd6ac0a';const agentId='820c896a-f3ad-43c0-9471-67a6c96836a7';
  await post('CreateOneRole','createOneRole',{createRoleInput:{id:roleId,label:'Automation operator',canBeAssignedToAgents:true}});
  db.prepare("INSERT INTO native_automation_resources (id,workspace_id,kind,name,status,config_json,created_by,created_at,updated_at) VALUES (?,?,'agent',?,'active','{}',?,?,?)").run(agentId,workspace,'Research agent',subject,now,now);
  const flags=await post('UpsertPermissionFlags','upsertPermissionFlags',{upsertPermissionFlagsInput:{roleId,permissionFlagKeys:['WORKFLOWS','TOOLS']}});
  expect(flags.status).toBe(200);expect(flags.body.data.upsertPermissionFlags.map((entry:any)=>entry.flag).sort()).toEqual(['TOOLS','WORKFLOWS']);
  const assigned=await post('AssignRoleToAgent','assignRoleToAgent',{agentId,roleId});expect(assigned.body.data.assignRoleToAgent).toBe(true);
  const listed=await post('GetRoles','getRoles');const role=listed.body.data.getRoles.find((entry:any)=>entry.id===roleId);
  expect(role.permissionFlags).toHaveLength(2);expect(role.agents[0]).toMatchObject({id:agentId,roleId});
  const removed=await post('RemoveRoleFromAgent','removeRoleFromAgent',{agentId});expect(removed.body.data.removeRoleFromAgent).toBe(true);
  expect(db.prepare('SELECT COUNT(*) AS count FROM agent_role_assignments').get()).toMatchObject({count:0});
});

it('enforces field projection/filter/write restrictions and row predicates', async () => {
  const roleId='ef6925df-d65e-433f-8b00-2713494291e5'; const allowedId=crypto.randomUUID();
  db.prepare('INSERT INTO contacts (id,workspace_id,first_name,last_name,email,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(allowedId,workspace,'Allowed','Person','private@example.invalid',now,now);
  await post('CreateOneRole','createOneRole',{createRoleInput:{id:roleId,label:'Scoped reader',canReadAllObjectRecords:true,canUpdateAllObjectRecords:true,canBeAssignedToUsers:true}});
  const objectMetadataId=await compatibilityId(`object:${workspace}:person`); const emailFieldId=await compatibilityId(`field:${objectMetadataId}:email`); const nameFieldId=await compatibilityId(`field:${objectMetadataId}:name`);
  expect((await post('UpsertFieldPermissions','upsertFieldPermissions',{upsertFieldPermissionsInput:{roleId,fieldPermissions:[{objectMetadataId,fieldMetadataId:emailFieldId,canReadFieldValue:false,canUpdateFieldValue:false}]}})).status).toBe(200);
  expect((await post('UpsertRowLevelPermissionPredicates','upsertRowLevelPermissionPredicates',{input:{roleId,objectMetadataId,predicates:[{fieldMetadataId:nameFieldId,subFieldName:'firstName',operand:'IS',value:'Allowed'}],predicateGroups:[]}})).status).toBe(200);
  const memberId=await compatibilityId(`member:${workspace}:${subject}`); await post('UpdateWorkspaceMemberRole','updateWorkspaceMemberRole',{workspaceMemberId:memberId,roleId});
  const listed=await post('FindManyPeople','people');
  expect(listed.status).toBe(200); expect(listed.body.data.people.nodes).toHaveLength(1); expect(listed.body.data.people.nodes[0]).toMatchObject({id:allowedId}); expect(listed.body.data.people.nodes[0]).not.toHaveProperty('email');
  const filtered=await post('FindManyPeople','people',{filter:{email:{eq:'private@example.invalid'}}}); expect(filtered.status).toBe(403);
  const updated=await post('UpdateOnePerson','updatePerson',{idToUpdate:allowedId,input:{email:'changed@example.invalid'}}); expect(updated.status).toBe(403);
  expect(db.prepare('SELECT email FROM contacts WHERE id=?').get(allowedId)).toMatchObject({email:'private@example.invalid'});
});
