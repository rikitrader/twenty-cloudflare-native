import type { Env } from './types';
import { compatibilityId } from './compatibility-id';

type Row = Record<string, any>;
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const inputFor = (vars: Row, key: string): Row => object(vars[key]) ? vars[key] : object(vars.input) ? vars.input : {};
const flag = (value: unknown, fallback = false) => value === undefined ? fallback : value === true;
const admin = (role: string) => role === 'owner' || role === 'admin';
const denied = () => Response.json({ errors: [{ message: 'admin access required', extensions: { code: 'FORBIDDEN' } }] }, { status: 403 });
const invalid = (message: string) => Response.json({ errors: [{ message, extensions: { code: 'BAD_USER_INPUT' } }] }, { status: 400 });

function roleValue(row: Row) {
  return {
    __typename: 'Role', id: row.id, label: row.label, description: row.description ?? null, icon: row.icon ?? null,
    canUpdateAllSettings: Boolean(row.can_update_all_settings), canAccessAllTools: Boolean(row.can_access_all_tools), isEditable: true,
    canReadAllObjectRecords: Boolean(row.can_read_all_object_records), canUpdateAllObjectRecords: Boolean(row.can_update_all_object_records),
    canSoftDeleteAllObjectRecords: Boolean(row.can_soft_delete_all_object_records), canDestroyAllObjectRecords: Boolean(row.can_destroy_all_object_records),
    canBeAssignedToUsers: Boolean(row.can_be_assigned_to_users), canBeAssignedToAgents: Boolean(row.can_be_assigned_to_agents), canBeAssignedToApiKeys: Boolean(row.can_be_assigned_to_api_keys),
  };
}
const builtins = [
  { __typename: 'Role', id: 'owner', label: 'Owner', description: 'Workspace owner', icon: 'IconUserShield', canUpdateAllSettings: true, canAccessAllTools: true, isEditable: false, canReadAllObjectRecords: true, canUpdateAllObjectRecords: true, canSoftDeleteAllObjectRecords: true, canDestroyAllObjectRecords: true, canBeAssignedToUsers: true, canBeAssignedToAgents: false, canBeAssignedToApiKeys: false },
  { __typename: 'Role', id: 'admin', label: 'Admin', description: 'Workspace administrator', icon: 'IconShield', canUpdateAllSettings: true, canAccessAllTools: true, isEditable: false, canReadAllObjectRecords: true, canUpdateAllObjectRecords: true, canSoftDeleteAllObjectRecords: true, canDestroyAllObjectRecords: true, canBeAssignedToUsers: true, canBeAssignedToAgents: false, canBeAssignedToApiKeys: true },
  { __typename: 'Role', id: 'member', label: 'Member', description: 'Standard workspace member', icon: 'IconUser', canUpdateAllSettings: false, canAccessAllTools: false, isEditable: false, canReadAllObjectRecords: true, canUpdateAllObjectRecords: true, canSoftDeleteAllObjectRecords: false, canDestroyAllObjectRecords: false, canBeAssignedToUsers: true, canBeAssignedToAgents: false, canBeAssignedToApiKeys: true },
];

async function memberValues(env: Env, workspaceId: string, roles: Map<string, Row>) {
  const rows = await env.CRM_DB!.prepare("SELECT m.identity_subject,m.role,m.created_at,u.email,p.display_name,ra.role_id FROM workspace_members m LEFT JOIN native_users u ON m.identity_subject='user:' || u.id LEFT JOIN voter_profiles p ON p.workspace_id=m.workspace_id AND p.identity_subject=m.identity_subject LEFT JOIN role_assignments ra ON ra.workspace_id=m.workspace_id AND ra.identity_subject=m.identity_subject WHERE m.workspace_id=? AND m.status='active' ORDER BY m.created_at").bind(workspaceId).all<Row>();
  return Promise.all(rows.results.map(async row => ({ __typename: 'WorkspaceMember', id: await compatibilityId(`member:${workspaceId}:${row.identity_subject}`), identitySubject: row.identity_subject, userEmail: row.email ?? '', name: { __typename: 'FullName', firstName: row.display_name ?? String(row.email ?? row.identity_subject).split('@')[0], lastName: '' }, roles: [row.role_id ? roles.get(row.role_id) : builtins.find(role => role.id === row.role)].filter(Boolean) })));
}

export async function crmRoles(op: string, vars: Row, env: Env, workspaceId: string, callerRole: string): Promise<Response | null> {
  const exact = /^(GetRoles|CreateOneRole|UpdateOneRole|DeleteOneRole|UpdateWorkspaceMemberRole|UpsertObjectPermissions|UpsertFieldPermissions|UpsertPermissionFlags|UpsertRowLevelPermissionPredicates|AssignRoleToAgent|RemoveRoleFromAgent)$/.test(op);
  if (!exact) return null;
  if (op !== 'GetRoles' && !admin(callerRole)) return denied();
  const db = env.CRM_DB!;
  const now = new Date().toISOString();
  if (op === 'GetRoles') {
    const roleRows = await db.prepare('SELECT * FROM custom_roles WHERE workspace_id=? ORDER BY label,id').bind(workspaceId).all<Row>();
    const custom = roleRows.results.map(roleValue); const byId = new Map(custom.map(role => [role.id, role]));
    const [members, objectRows, fieldRows, predicateRows, groupRows, flagRows, agentRows] = await Promise.all([
      memberValues(env, workspaceId, byId),
      db.prepare('SELECT * FROM object_permissions WHERE workspace_id=?').bind(workspaceId).all<Row>(),
      db.prepare('SELECT * FROM field_permissions WHERE workspace_id=?').bind(workspaceId).all<Row>(),
      db.prepare('SELECT * FROM row_permission_predicates WHERE workspace_id=?').bind(workspaceId).all<Row>(),
      db.prepare('SELECT * FROM row_permission_groups WHERE workspace_id=?').bind(workspaceId).all<Row>(),
      db.prepare('SELECT * FROM role_permission_flags WHERE workspace_id=?').bind(workspaceId).all<Row>(),
      db.prepare("SELECT a.id,a.name,a.description,a.status,ar.role_id FROM native_automation_resources a JOIN agent_role_assignments ar ON ar.workspace_id=a.workspace_id AND ar.agent_id=a.id WHERE a.workspace_id=? AND a.kind='agent' AND a.status!='deleted'").bind(workspaceId).all<Row>(),
    ]);
    const roles = [...builtins, ...custom].map(role => ({ ...role, workspaceMembers: members.filter(member => member.roles[0]?.id === role.id), agents: agentRows.results.filter(agent=>agent.role_id===role.id).map(agent=>({__typename:'Agent',id:agent.id,name:agent.name,label:agent.name,description:agent.description,roleId:role.id,isCustom:true,prompt:'',modelId:'',evaluationInputs:[],createdAt:null,updatedAt:null})), apiKeys: [], permissionFlags: flagRows.results.filter(row=>row.role_id===role.id).map(row=>({__typename:'RolePermissionFlag',id:row.id,flag:row.flag,roleId:row.role_id})),
      objectPermissions: objectRows.results.filter(row => row.role_id === role.id).map(row => ({ __typename: 'ObjectPermission', objectMetadataId: row.object_metadata_id, canReadObjectRecords: row.can_read_object_records == null ? null : Boolean(row.can_read_object_records), canUpdateObjectRecords: row.can_update_object_records == null ? null : Boolean(row.can_update_object_records), canSoftDeleteObjectRecords: row.can_soft_delete_object_records == null ? null : Boolean(row.can_soft_delete_object_records), canDestroyObjectRecords: row.can_destroy_object_records == null ? null : Boolean(row.can_destroy_object_records), restrictedFields: {}, rowLevelPermissionPredicates: [], rowLevelPermissionPredicateGroups: [] })),
      fieldPermissions: fieldRows.results.filter(row => row.role_id === role.id).map(row => ({ __typename: 'FieldPermission', id: row.id, roleId: row.role_id, objectMetadataId: row.object_metadata_id, fieldMetadataId: row.field_metadata_id, canReadFieldValue: row.can_read_field_value == null ? null : Boolean(row.can_read_field_value), canUpdateFieldValue: row.can_update_field_value == null ? null : Boolean(row.can_update_field_value) })),
      rowLevelPermissionPredicates: predicateRows.results.filter(row => row.role_id === role.id).map(row => ({ __typename: 'RowLevelPermissionPredicate', id: row.id, roleId: row.role_id, objectMetadataId: row.object_metadata_id, fieldMetadataId: row.field_metadata_id, operand: row.operand, value: row.value_json ? JSON.parse(row.value_json) : null, subFieldName: row.sub_field_name, workspaceMemberFieldMetadataId: row.workspace_member_field_metadata_id, workspaceMemberSubFieldName: row.workspace_member_sub_field_name, rowLevelPermissionPredicateGroupId: row.group_id, positionInRowLevelPermissionPredicateGroup: row.position })),
      rowLevelPermissionPredicateGroups: groupRows.results.filter(row => row.role_id === role.id).map(row => ({ __typename: 'RowLevelPermissionPredicateGroup', id: row.id, roleId: row.role_id, objectMetadataId: row.object_metadata_id, parentRowLevelPermissionPredicateGroupId: row.parent_group_id, logicalOperator: row.logical_operator, positionInRowLevelPermissionPredicateGroup: row.position })),
    }));
    return Response.json({ data: { getRoles: roles } });
  }
  if (op === 'CreateOneRole') {
    const raw = inputFor(vars, 'createRoleInput'); const label = typeof raw.label === 'string' ? raw.label.trim().slice(0, 100) : '';
    if (!label) return invalid('Role label is required'); const id = typeof raw.id === 'string' ? raw.id : crypto.randomUUID();
    await db.prepare('INSERT INTO custom_roles VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, workspaceId, label, typeof raw.description === 'string' ? raw.description.slice(0,500) : null, typeof raw.icon === 'string' ? raw.icon.slice(0,100) : null, Number(flag(raw.canUpdateAllSettings)), Number(flag(raw.canAccessAllTools)), Number(flag(raw.canReadAllObjectRecords)), Number(flag(raw.canUpdateAllObjectRecords)), Number(flag(raw.canSoftDeleteAllObjectRecords)), Number(flag(raw.canDestroyAllObjectRecords)), Number(flag(raw.canBeAssignedToUsers,true)), Number(flag(raw.canBeAssignedToAgents)), Number(flag(raw.canBeAssignedToApiKeys)), now, now).run();
    return Response.json({ data: { createOneRole: roleValue((await db.prepare('SELECT * FROM custom_roles WHERE workspace_id=? AND id=?').bind(workspaceId,id).first<Row>())!) } });
  }
  if (op === 'UpdateOneRole') {
    const raw = inputFor(vars, 'updateRoleInput'); const id = String(raw.id ?? ''); const update = object(raw.update) ? raw.update : {};
    if (['owner','admin','member'].includes(id)) return invalid('Built-in roles are immutable');
    const existing = await db.prepare('SELECT * FROM custom_roles WHERE workspace_id=? AND id=?').bind(workspaceId,id).first<Row>(); if (!existing) return invalid('Role not found');
    const columns: [string,string][] = [['label','label'],['description','description'],['icon','icon'],['canUpdateAllSettings','can_update_all_settings'],['canAccessAllTools','can_access_all_tools'],['canReadAllObjectRecords','can_read_all_object_records'],['canUpdateAllObjectRecords','can_update_all_object_records'],['canSoftDeleteAllObjectRecords','can_soft_delete_all_object_records'],['canDestroyAllObjectRecords','can_destroy_all_object_records'],['canBeAssignedToUsers','can_be_assigned_to_users'],['canBeAssignedToAgents','can_be_assigned_to_agents'],['canBeAssignedToApiKeys','can_be_assigned_to_api_keys']];
    const sets = ['updated_at=?']; const values: unknown[] = [now]; for (const [key,column] of columns) if (update[key] !== undefined) { sets.push(`${column}=?`); values.push(key.startsWith('can') ? Number(update[key] === true) : String(update[key]).slice(0,key==='description'?500:100)); }
    await db.prepare(`UPDATE custom_roles SET ${sets.join(',')} WHERE workspace_id=? AND id=?`).bind(...values,workspaceId,id).run();
    return Response.json({ data: { updateOneRole: roleValue((await db.prepare('SELECT * FROM custom_roles WHERE workspace_id=? AND id=?').bind(workspaceId,id).first<Row>())!) } });
  }
  if (op === 'DeleteOneRole') {
    const id = String(vars.roleId ?? vars.id ?? inputFor(vars,'input').id ?? ''); if (['owner','admin','member'].includes(id)) return invalid('Built-in roles cannot be deleted');
    if (await db.prepare('SELECT 1 FROM role_assignments WHERE workspace_id=? AND role_id=? LIMIT 1').bind(workspaceId,id).first()) return invalid('Reassign members before deleting this role');
    const existing = await db.prepare('SELECT * FROM custom_roles WHERE workspace_id=? AND id=?').bind(workspaceId,id).first<Row>(); if (!existing) return invalid('Role not found');
    await db.prepare('DELETE FROM custom_roles WHERE workspace_id=? AND id=?').bind(workspaceId,id).run(); return Response.json({ data: { deleteOneRole: roleValue(existing) } });
  }
  if (op === 'UpdateWorkspaceMemberRole') {
    const memberId = String(vars.workspaceMemberId ?? ''); const roleId = String(vars.roleId ?? ''); const members = await db.prepare("SELECT identity_subject,role FROM workspace_members WHERE workspace_id=? AND status='active'").bind(workspaceId).all<Row>();
    let selected: Row | undefined; for (const candidate of members.results) if (candidate.identity_subject === memberId || await compatibilityId(`member:${workspaceId}:${candidate.identity_subject}`) === memberId) { selected = candidate; break; }
    if (!selected) return invalid('Workspace member not found');
    if (['owner','admin','member'].includes(roleId)) { if (roleId === 'owner' && callerRole !== 'owner') return denied(); await db.batch([db.prepare('DELETE FROM role_assignments WHERE workspace_id=? AND identity_subject=?').bind(workspaceId,selected.identity_subject),db.prepare('UPDATE workspace_members SET role=? WHERE workspace_id=? AND identity_subject=?').bind(roleId,workspaceId,selected.identity_subject)]); }
    else { const role = await db.prepare('SELECT * FROM custom_roles WHERE workspace_id=? AND id=? AND can_be_assigned_to_users=1').bind(workspaceId,roleId).first<Row>(); if (!role) return invalid('Assignable role not found'); await db.prepare('INSERT INTO role_assignments VALUES (?,?,?,?,?) ON CONFLICT(workspace_id,identity_subject) DO UPDATE SET role_id=excluded.role_id,updated_at=excluded.updated_at').bind(workspaceId,selected.identity_subject,roleId,now,now).run(); }
    const rows = new Map<string,Row>(); if (!['owner','admin','member'].includes(roleId)) { const row=await db.prepare('SELECT * FROM custom_roles WHERE workspace_id=? AND id=?').bind(workspaceId,roleId).first<Row>(); if(row) rows.set(roleId,roleValue(row)); }
    const member = (await memberValues(env,workspaceId,rows)).find(value=>value.identitySubject===selected!.identity_subject); return Response.json({data:{updateWorkspaceMemberRole:member}});
  }
  if (op === 'AssignRoleToAgent' || op === 'RemoveRoleFromAgent') {
    const agentId=String(vars.agentId??'');if(!agentId)return invalid('Agent is required');
    const agent=await db.prepare("SELECT 1 FROM native_automation_resources WHERE workspace_id=? AND id=? AND kind='agent' AND status!='deleted'").bind(workspaceId,agentId).first();if(!agent)return invalid('Agent not found');
    if(op==='RemoveRoleFromAgent'){await db.prepare('DELETE FROM agent_role_assignments WHERE workspace_id=? AND agent_id=?').bind(workspaceId,agentId).run();return Response.json({data:{removeRoleFromAgent:true}});}
    const roleId=String(vars.roleId??'');const role=await db.prepare('SELECT 1 FROM custom_roles WHERE workspace_id=? AND id=? AND can_be_assigned_to_agents=1').bind(workspaceId,roleId).first();if(!role)return invalid('Assignable agent role not found');
    await db.prepare('INSERT INTO agent_role_assignments VALUES (?,?,?,?,?) ON CONFLICT(workspace_id,agent_id) DO UPDATE SET role_id=excluded.role_id,updated_at=excluded.updated_at').bind(workspaceId,agentId,roleId,now,now).run();return Response.json({data:{assignRoleToAgent:true}});
  }
  const raw = inputFor(vars, op === 'UpsertObjectPermissions' ? 'upsertObjectPermissionsInput' : op === 'UpsertFieldPermissions' ? 'upsertFieldPermissionsInput' : op === 'UpsertPermissionFlags' ? 'upsertPermissionFlagsInput' : 'input'); const roleId = String(raw.roleId ?? '');
  if (!roleId || !(await db.prepare('SELECT 1 FROM custom_roles WHERE workspace_id=? AND id=?').bind(workspaceId,roleId).first())) return invalid('Custom role not found');
  if(op==='UpsertPermissionFlags'){
    const keys=Array.isArray(raw.permissionFlagKeys)?[...new Set(raw.permissionFlagKeys.filter((value):value is string=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{1,80}$/.test(value)))]:[];
    if(keys.length>100||keys.length!==(Array.isArray(raw.permissionFlagKeys)?new Set(raw.permissionFlagKeys).size:0))return invalid('Invalid permission flags');
    const statements:D1PreparedStatement[]=[db.prepare('DELETE FROM role_permission_flags WHERE workspace_id=? AND role_id=?').bind(workspaceId,roleId)];const output=[];
    for(const key of keys){const id=await compatibilityId(`role-flag:${workspaceId}:${roleId}:${key}`);statements.push(db.prepare('INSERT INTO role_permission_flags VALUES (?,?,?,?,?)').bind(id,workspaceId,roleId,key,now));output.push({__typename:'RolePermissionFlag',id,flag:key,roleId});}
    await db.batch(statements);return Response.json({data:{upsertPermissionFlags:output}});
  }
  if (op === 'UpsertObjectPermissions') {
    const records = Array.isArray(raw.objectPermissions) ? raw.objectPermissions.filter(object) : []; if (!records.length || records.length > 100) return invalid('Object permissions are required'); const output=[];
    for (const item of records) { const metadataId=String(item.objectMetadataId??''); if(!metadataId) return invalid('objectMetadataId is required'); await db.prepare('INSERT INTO object_permissions VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,role_id,object_metadata_id) DO UPDATE SET can_read_object_records=excluded.can_read_object_records,can_update_object_records=excluded.can_update_object_records,can_soft_delete_object_records=excluded.can_soft_delete_object_records,can_destroy_object_records=excluded.can_destroy_object_records,updated_at=excluded.updated_at').bind(workspaceId,roleId,metadataId,item.canReadObjectRecords==null?null:Number(item.canReadObjectRecords===true),item.canUpdateObjectRecords==null?null:Number(item.canUpdateObjectRecords===true),item.canSoftDeleteObjectRecords==null?null:Number(item.canSoftDeleteObjectRecords===true),item.canDestroyObjectRecords==null?null:Number(item.canDestroyObjectRecords===true),now).run(); output.push({__typename:'ObjectPermission',objectMetadataId:metadataId,...item,restrictedFields:{},rowLevelPermissionPredicates:[],rowLevelPermissionPredicateGroups:[]}); }
    return Response.json({data:{upsertObjectPermissions:output}});
  }
  if (op === 'UpsertFieldPermissions') {
    const records=Array.isArray(raw.fieldPermissions)?raw.fieldPermissions.filter(object):[]; if(!records.length||records.length>200)return invalid('Field permissions are required'); const output=[];
    for(const item of records){const objectId=String(item.objectMetadataId??''),fieldId=String(item.fieldMetadataId??'');if(!objectId||!fieldId)return invalid('Object and field metadata IDs are required');const id=await compatibilityId(`field-permission:${workspaceId}:${roleId}:${fieldId}`);await db.prepare('INSERT INTO field_permissions VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,role_id,object_metadata_id,field_metadata_id) DO UPDATE SET can_read_field_value=excluded.can_read_field_value,can_update_field_value=excluded.can_update_field_value,updated_at=excluded.updated_at').bind(id,workspaceId,roleId,objectId,fieldId,item.canReadFieldValue==null?null:Number(item.canReadFieldValue===true),item.canUpdateFieldValue==null?null:Number(item.canUpdateFieldValue===true),now).run();output.push({__typename:'FieldPermission',id,roleId,objectMetadataId:objectId,fieldMetadataId:fieldId,canReadFieldValue:item.canReadFieldValue??null,canUpdateFieldValue:item.canUpdateFieldValue??null});}
    return Response.json({data:{upsertFieldPermissions:output}});
  }
  const objectId=String(raw.objectMetadataId??''); const predicates=Array.isArray(raw.predicates)?raw.predicates.filter(object):[]; const groups=Array.isArray(raw.predicateGroups)?raw.predicateGroups.filter(object):[]; if(!objectId||predicates.length>100||groups.length>50)return invalid('Invalid row permission input');
  const statements:D1PreparedStatement[]=[db.prepare('DELETE FROM row_permission_predicates WHERE workspace_id=? AND role_id=? AND object_metadata_id=?').bind(workspaceId,roleId,objectId),db.prepare('DELETE FROM row_permission_groups WHERE workspace_id=? AND role_id=? AND object_metadata_id=?').bind(workspaceId,roleId,objectId)]; const groupOutput=[]; const predicateOutput=[];
  for(const group of groups){const id=typeof group.id==='string'?group.id:crypto.randomUUID();const logical=group.logicalOperator==='OR'?'OR':'AND';statements.push(db.prepare('INSERT INTO row_permission_groups VALUES (?,?,?,?,?,?,?)').bind(id,workspaceId,roleId,objectId,group.parentRowLevelPermissionPredicateGroupId??null,logical,Number.isInteger(group.positionInRowLevelPermissionPredicateGroup)?group.positionInRowLevelPermissionPredicateGroup:null));groupOutput.push({__typename:'RowLevelPermissionPredicateGroup',id,roleId,objectMetadataId:objectId,parentRowLevelPermissionPredicateGroupId:group.parentRowLevelPermissionPredicateGroupId??null,logicalOperator:logical,positionInRowLevelPermissionPredicateGroup:group.positionInRowLevelPermissionPredicateGroup??null});}
  for(const predicate of predicates){const id=typeof predicate.id==='string'?predicate.id:crypto.randomUUID();const operand=String(predicate.operand??'');if(!/^[A-Z_]{2,40}$/.test(operand))return invalid('Invalid row predicate operand');statements.push(db.prepare('INSERT INTO row_permission_predicates VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(id,workspaceId,roleId,objectId,String(predicate.fieldMetadataId??''),operand,predicate.value===undefined?null:JSON.stringify(predicate.value),predicate.subFieldName??null,predicate.workspaceMemberFieldMetadataId??null,predicate.workspaceMemberSubFieldName??null,predicate.rowLevelPermissionPredicateGroupId??null,Number.isInteger(predicate.positionInRowLevelPermissionPredicateGroup)?predicate.positionInRowLevelPermissionPredicateGroup:null));predicateOutput.push({__typename:'RowLevelPermissionPredicate',id,roleId,objectMetadataId:objectId,...predicate});}
  await db.batch(statements); return Response.json({data:{upsertRowLevelPermissionPredicates:{predicates:predicateOutput,predicateGroups:groupOutput}}});
}
