import type { Env } from './types';
import { compatibilityId } from './compatibility-id';

type Row = Record<string, unknown>;
type Scalar = string | number | null;
type Right = 'read' | 'create' | 'update' | 'delete';
export type CrmPermissions = Record<Right, boolean>;
type Entity = { singular: string; plural: string; table: string; fields: Record<string, string>; relations: Record<string, [string, string]> };
const base = { id: 'id', createdAt: 'created_at', updatedAt: 'updated_at', deletedAt: 'deleted_at' };
const entities: Entity[] = [
  { singular: 'person', plural: 'people', table: 'contacts', fields: { ...base, firstName: 'first_name', lastName: 'last_name', email: 'email' }, relations: {} },
  { singular: 'company', plural: 'companies', table: 'companies', fields: { ...base, name: 'name', domain: 'domain', domainName: 'domain' }, relations: {} },
  { singular: 'opportunity', plural: 'opportunities', table: 'opportunities', fields: { ...base, name: 'name', amount: 'amount_cents', amountCents: 'amount_cents', stage: 'stage' }, relations: { company: ['company_id', 'companies'], pointOfContact: ['point_of_contact_id', 'contacts'], pipeline: ['pipeline_id', 'pipelines'] } },
  { singular: 'activity', plural: 'activities', table: 'activities', fields: { ...base, title: 'title', body: 'body', type: 'type', dueAt: 'due_at', completedAt: 'completed_at' }, relations: { contact: ['contact_id', 'contacts'], company: ['company_id', 'companies'], opportunity: ['opportunity_id', 'opportunities'] } },
  { singular: 'blocklist', plural: 'blocklists', table: 'blocklist', fields: { ...base, handle: 'handle', scope: 'scope' }, relations: {} },
];
const cap = (value: string) => value[0].toUpperCase() + value.slice(1);
const sortDirections = new Map<string, string>([
  ['AscNullsFirst', 'ASC NULLS FIRST'], ['AscNullsLast', 'ASC NULLS LAST'],
  ['DescNullsFirst', 'DESC NULLS FIRST'], ['DescNullsLast', 'DESC NULLS LAST'],
  ['ASC', 'ASC'], ['DESC', 'DESC'],
  ['ASC_NULLS_FIRST', 'ASC NULLS FIRST'], ['ASC_NULLS_LAST', 'ASC NULLS LAST'],
  ['DESC_NULLS_FIRST', 'DESC NULLS FIRST'], ['DESC_NULLS_LAST', 'DESC NULLS LAST'],
]);
/** Exact Twenty OrderByDirection enum plus the existing uppercase API aliases. */
export const crmSortDirection = (direction: unknown): string | null => typeof direction === 'string' ? sortDirections.get(direction) ?? null : null;
const object = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
class ContractError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const bad = (message: string, status = 400): never => { throw new ContractError(message, status); };
const scalar = (value: unknown): Scalar => value === null || typeof value === 'string' || typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'boolean' ? Number(value) : bad('Expected a scalar field value');
const parseJson = (value: unknown): Row => {
  if (typeof value !== 'string') return {};
  try { const parsed: unknown = JSON.parse(value); return object(parsed) ? parsed : {}; } catch { return {}; }
};

/** The role comes only from the authenticated membership, never request variables. */
export async function crmPermissions(env: Env, workspaceId: string, role: string, objectType?: string): Promise<CrmPermissions> {
  const denied = { read: false, create: false, update: false, delete: false };
  if (role.startsWith('custom:')) {
    const roleId = role.slice(7);
    const custom = await env.CRM_DB!.prepare('SELECT can_read_all_object_records,can_update_all_object_records,can_soft_delete_all_object_records,can_destroy_all_object_records FROM custom_roles WHERE workspace_id=? AND id=?').bind(workspaceId,roleId).first<Record<string,number>>();
    if (!custom) return denied;
    const result = { read: Boolean(custom.can_read_all_object_records), create: Boolean(custom.can_update_all_object_records), update: Boolean(custom.can_update_all_object_records), delete: Boolean(custom.can_soft_delete_all_object_records && custom.can_destroy_all_object_records) };
    if (!objectType) return result;
    const objectMetadataId = await compatibilityId(`object:${workspaceId}:${objectType}`);
    const permission = await env.CRM_DB!.prepare('SELECT can_read_object_records,can_update_object_records,can_soft_delete_object_records,can_destroy_object_records FROM object_permissions WHERE workspace_id=? AND role_id=? AND object_metadata_id=?').bind(workspaceId,roleId,objectMetadataId).first<Record<string,number|null>>();
    if (!permission) return result;
    return {
      read: permission.can_read_object_records == null ? result.read : Boolean(permission.can_read_object_records),
      create: permission.can_update_object_records == null ? result.create : Boolean(permission.can_update_object_records),
      update: permission.can_update_object_records == null ? result.update : Boolean(permission.can_update_object_records),
      delete: permission.can_soft_delete_object_records == null || permission.can_destroy_object_records == null ? result.delete : Boolean(permission.can_soft_delete_object_records && permission.can_destroy_object_records),
    };
  }
  if (!['owner', 'admin', 'member'].includes(role)) return denied;
  const row = await env.CRM_DB!.prepare("SELECT value_json FROM workspace_settings WHERE workspace_id = ? AND setting_key = 'permissions'").bind(workspaceId).first<{value_json: string}>();
  if (!row) return { read: true, create: true, update: true, delete: role !== 'member' };
  const config = parseJson(row.value_json)[role];
  if (!object(config)) return denied;
  return { read: config.read === true, create: config.create === true, update: config.update === true, delete: config.delete === true };
}

type CustomField = { id: string; object_type: string; field_key: string; field_type: string; options_json: string | null };
type Context = { env: Env; workspaceId: string; entity: Entity; custom: CustomField[]; allCustom: CustomField[]; readDenied: Set<string>; writeDenied: Set<string>; rowSql: string; rowParams: Scalar[] };
const customFor = (fields: CustomField[], entity: Entity) => fields.filter(field => field.object_type === (entity.singular === 'person' ? 'contact' : entity.singular));
async function roleControls(env: Env, workspaceId: string, role: string, entity: Entity, custom: CustomField[], actorSubject: string): Promise<Pick<Context,'readDenied'|'writeDenied'|'rowSql'|'rowParams'>> {
  const empty = { readDenied: new Set<string>(), writeDenied: new Set<string>(), rowSql: '1 = 1', rowParams: [] as Scalar[] };
  if (!role.startsWith('custom:')) return empty;
  const roleId = role.slice(7); const objectId = await compatibilityId(`object:${workspaceId}:${entity.singular}`);
  const names = new Map<string,string>();
  for (const name of new Set([...Object.keys(entity.fields), ...Object.keys(entity.relations), ...custom.map(field => field.field_key), ...(entity.singular === 'person' ? ['name'] : [])])) {
    const customField = custom.find(field => field.field_key === name);
    names.set(customField ? (customField as Row).id as string : await compatibilityId(`field:${objectId}:${name}`), name);
  }
  const permissions = await env.CRM_DB!.prepare('SELECT field_metadata_id,can_read_field_value,can_update_field_value FROM field_permissions WHERE workspace_id=? AND role_id=? AND object_metadata_id=?').bind(workspaceId,roleId,objectId).all<{field_metadata_id:string;can_read_field_value:number|null;can_update_field_value:number|null}>();
  for (const permission of permissions.results) { const name=names.get(permission.field_metadata_id); if(!name) continue; if(permission.can_read_field_value===0) empty.readDenied.add(name); if(permission.can_update_field_value===0) empty.writeDenied.add(name); }
  const [predicates,groups] = await Promise.all([
    env.CRM_DB!.prepare('SELECT * FROM row_permission_predicates WHERE workspace_id=? AND role_id=? AND object_metadata_id=? ORDER BY position,id').bind(workspaceId,roleId,objectId).all<Row>(),
    env.CRM_DB!.prepare('SELECT * FROM row_permission_groups WHERE workspace_id=? AND role_id=? AND object_metadata_id=? ORDER BY position,id').bind(workspaceId,roleId,objectId).all<Row>(),
  ]);
  if (!predicates.results.length) return empty;
  const params: Scalar[]=[];
  const expression = (predicate: Row): string => {
    const name=names.get(String(predicate.field_metadata_id)); if(!name || empty.readDenied.has(name)) return '0 = 1';
    let column: string;
    if(entity.singular==='person'&&name==='name') column="(first_name || ' ' || last_name)";
    else if(entity.fields[name]) column=entity.fields[name];
    else if(entity.relations[name]) column=entity.relations[name][0];
    else if(custom.some(field=>field.field_key===name)) column=`json_extract(custom_fields_json, '$.${name}')`;
    else return '0 = 1';
    if (predicate.sub_field_name) {
      if(entity.singular==='person'&&name==='name'&&predicate.sub_field_name==='firstName') column='first_name';
      else if(entity.singular==='person'&&name==='name'&&predicate.sub_field_name==='lastName') column='last_name';
      else if(/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(String(predicate.sub_field_name))) column=`json_extract(${column}, '$.${String(predicate.sub_field_name)}')`;
      else return '0 = 1';
    }
    let value: unknown=null; try { value=predicate.workspace_member_field_metadata_id ? actorSubject : predicate.value_json == null ? null : JSON.parse(String(predicate.value_json)); } catch { return '0 = 1'; }
    const bind=(operator:string,val:unknown)=>{params.push(scalar(val));return `${column} ${operator} ?`;};
    switch(predicate.operand){
      case 'IS': return value===null?`${column} IS NULL`:bind('=',value);
      case 'IS_NOT': return value===null?`${column} IS NOT NULL`:bind('<>',value);
      case 'IS_NOT_NULL': return `${column} IS NOT NULL`;
      case 'LESS_THAN_OR_EQUAL': case 'IS_BEFORE': return bind('<=',value);
      case 'GREATER_THAN_OR_EQUAL': case 'IS_AFTER': return bind('>=',value);
      case 'CONTAINS': params.push(`%${String(value??'')}%`); return `${column} LIKE ?`;
      case 'DOES_NOT_CONTAIN': params.push(`%${String(value??'')}%`); return `${column} NOT LIKE ?`;
      case 'IS_EMPTY': return `(${column} IS NULL OR CAST(${column} AS TEXT)='')`;
      case 'IS_NOT_EMPTY': return `(${column} IS NOT NULL AND CAST(${column} AS TEXT)<>'')`;
      case 'IS_IN_PAST': return `${column} < datetime('now')`;
      case 'IS_IN_FUTURE': return `${column} > datetime('now')`;
      case 'IS_TODAY': return `date(${column}) = date('now')`;
      default: return '0 = 1';
    }
  };
  const grouped=new Map<string|null,Row[]>(); for(const predicate of predicates.results){const key=predicate.group_id==null?null:String(predicate.group_id);grouped.set(key,[...(grouped.get(key)??[]),predicate]);}
  const children=new Map<string|null,Row[]>(); for(const group of groups.results){const key=group.parent_group_id==null?null:String(group.parent_group_id);children.set(key,[...(children.get(key)??[]),group]);}
  const visited=new Set<string>();
  const compileGroup=(group:Row,depth:number):string=>{const id=String(group.id);if(depth>5||visited.has(id))return '0 = 1';visited.add(id);const join=group.logical_operator==='OR'?' OR ':' AND ';const parts=[...(grouped.get(id)??[]).map(expression),...(children.get(id)??[]).map(child=>compileGroup(child,depth+1))];visited.delete(id);return parts.length?`(${parts.join(join)})`:'1 = 1';};
  const rootParts=[...(grouped.get(null)??[]).map(expression),...(children.get(null)??[]).map(group=>compileGroup(group,0))];
  return {...empty,rowSql:rootParts.length?rootParts.map(part=>`(${part})`).join(' AND '):'1 = 1',rowParams:params};
}
const fieldExpression = (ctx: Context, key: string): string => {
  if (ctx.readDenied.has(key)) return bad(`Field access denied: ${key}`, 403);
  if (key === 'name' && ctx.entity.singular === 'person') return "(first_name || ' ' || last_name)";
  if (ctx.entity.fields[key]) return ctx.entity.fields[key];
  const relation = Object.entries(ctx.entity.relations).find(([name]) => key === name || key === `${name}Id`);
  if (relation) return relation[1][0];
  if (ctx.custom.some(field => field.field_key === key) && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) return `json_extract(custom_fields_json, '$.${key}')`;
  return bad(`Unsupported field: ${key}`);
};
const fieldScalar = (key: string, value: unknown): Scalar => {
  if (key === 'amount' && value !== null) {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(Math.round(value * 100))) return bad('amount must be a finite number');
    return Math.round(value * 100);
  }
  return scalar(value);
};

function filterSql(ctx: Context, input: unknown, params: Scalar[], depth = 0): string {
  if (input === undefined || input === null) return '1 = 1';
  if (!object(input) || depth > 8) return bad('Invalid or excessively nested filter');
  const clauses: string[] = [];
  for (const [key, condition] of Object.entries(input)) {
    if (params.length > 75) return bad('Filter exceeds the parameter limit');
    if (key === 'and' || key === 'or') {
      if (!Array.isArray(condition) || condition.length > 50) return bad('Invalid filter group');
      clauses.push(condition.length ? `(${condition.map(item => filterSql(ctx, item, params, depth + 1)).join(key === 'and' ? ' AND ' : ' OR ')})` : key === 'and' ? '1 = 1' : '0 = 1');
      continue;
    }
    if (key === 'not') { clauses.push(`NOT (${filterSql(ctx, condition, params, depth + 1)})`); continue; }
    if (!object(condition)) return bad(`Invalid filter for ${key}`);
    if (key === 'name' && ctx.entity.singular === 'person' && ('firstName' in condition || 'lastName' in condition)) {
      if (Object.keys(condition).some(name => !['firstName', 'lastName'].includes(name))) return bad('Invalid full-name filter');
      clauses.push(filterSql(ctx, condition, params, depth + 1)); continue;
    }
    if (key in ctx.entity.relations && object(condition.id)) {
      if (Object.keys(condition).length !== 1) return bad('Only relation ID filters are supported');
      clauses.push(filterSql(ctx, { [`${key}Id`]: condition.id }, params, depth + 1)); continue;
    }
    const column = fieldExpression(ctx, key);
    for (const [operator, value] of Object.entries(condition)) {
      const comparison = ({ eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as Record<string, string>)[operator];
      if (comparison) {
        if (value === null && (operator === 'eq' || operator === 'neq')) clauses.push(`${column} IS ${operator === 'neq' ? 'NOT ' : ''}NULL`);
        else { clauses.push(`${column} ${comparison} ?`); params.push(fieldScalar(key, value)); }
      } else if (operator === 'in' || operator === 'notIn') {
        if (!Array.isArray(value) || value.length > 60) return bad('Invalid set filter');
        clauses.push(value.length ? `${column} ${operator === 'notIn' ? 'NOT ' : ''}IN (${value.map(() => '?').join(',')})` : operator === 'in' ? '0 = 1' : '1 = 1');
        params.push(...value.map(item => fieldScalar(key, item)));
      } else if (operator === 'ilike' || operator === 'like' || operator === 'notIlike') {
        if (typeof value !== 'string' || value.length > 1000) return bad('Invalid text filter');
        // Twenty already supplies SQL wildcard patterns; do not add another %.
        clauses.push(`${column} ${operator === 'notIlike' ? 'NOT ' : ''}LIKE ?`); params.push(value);
      } else if (operator === 'is') {
        if (![null, 'NULL', 'NOT_NULL'].includes(value as never)) return bad('Invalid null filter');
        clauses.push(`${column} IS ${value === 'NOT_NULL' ? 'NOT ' : ''}NULL`);
      } else return bad(`Unsupported filter operator: ${operator}`);
    }
  }
  if (params.length > 80) return bad('Filter exceeds the parameter limit');
  return clauses.length ? clauses.map(c => `(${c})`).join(' AND ') : '1 = 1';
}
const mentionsDeleted = (filter: unknown): boolean => object(filter) && ('deletedAt' in filter || Object.values(filter).some(value => Array.isArray(value) ? value.some(mentionsDeleted) : mentionsDeleted(value)));
function where(ctx: Context, filter: unknown, lifecycle: 'active' | 'deleted' | 'any' = 'active'): { sql: string; params: Scalar[] } {
  const params: Scalar[] = [ctx.workspaceId];
  const predicate = filterSql(ctx, filter, params);
  const lifecycleSql = lifecycle === 'any' || mentionsDeleted(filter) ? '' : lifecycle === 'deleted' ? ' AND deleted_at IS NOT NULL' : ' AND deleted_at IS NULL';
  params.push(...ctx.rowParams);
  return { sql: `workspace_id = ?${lifecycleSql} AND (${predicate}) AND (${ctx.rowSql})`, params };
}
function orderSql(ctx: Context, input: unknown): string {
  if (input === undefined || input === null) return 'created_at DESC, id ASC';
  if (!Array.isArray(input) || input.length > 8) return bad('orderBy must be an array');
  const out: string[] = [];
  const append = (key: string, direction: unknown) => {
    if (key === 'name' && ctx.entity.singular === 'person' && object(direction)) {
      for (const [subkey, value] of Object.entries(direction)) { if (!['firstName', 'lastName'].includes(subkey)) return bad('Invalid full-name sort'); append(subkey, value); }
      return;
    }
    const sqlDirection = crmSortDirection(direction);
    if (!sqlDirection) return bad('Invalid sort direction');
    out.push(`${fieldExpression(ctx, key)} ${sqlDirection}`);
  };
  for (const item of input) { if (!object(item)) return bad('Invalid sort field'); for (const [key, direction] of Object.entries(item)) append(key, direction); }
  out.push('id ASC'); return out.join(', ');
}

const cursor = (offset: number) => btoa(JSON.stringify({ v: 1, offset }));
const cursorOffset = (value: unknown): number => {
  if (typeof value !== 'string' || value.length > 150) return bad('Invalid cursor');
  try { const data = JSON.parse(atob(value)); if (data.v !== 1 || !Number.isInteger(data.offset) || data.offset < 0 || data.offset > 1_000_000) return bad('Invalid cursor'); return data.offset; } catch { return bad('Invalid cursor'); }
};
const connection = (entity: Entity, nodes: Row[], totalCount: number, offset = 0) => ({
  __typename: `${cap(entity.singular)}Connection`, nodes,
  edges: nodes.map((node, index) => ({ __typename: `${cap(entity.singular)}Edge`, node, cursor: cursor(offset + index) })),
  totalCount, pageInfo: { __typename: 'PageInfo', hasNextPage: offset + nodes.length < totalCount, hasPreviousPage: offset > 0, startCursor: nodes.length ? cursor(offset) : null, endCursor: nodes.length ? cursor(offset + nodes.length - 1) : null },
});
function baseRecord(entity: Entity, row: Row, custom: CustomField[] = []): Row {
  const out: Row = { ...Object.fromEntries(custom.map(field => [field.field_key, null])), ...parseJson(row.custom_fields_json), __typename: cap(entity.singular), id: row.id, createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at ?? null };
  for (const [name, column] of Object.entries(entity.fields)) out[name] = row[column] ?? null;
  if (entity.singular === 'person') out.name = { __typename: 'FullName', firstName: row.first_name, lastName: row.last_name };
  if (entity.singular === 'opportunity') out.amount = row.amount_cents === null ? null : Number(row.amount_cents) / 100;
  for (const [name, [column]] of Object.entries(entity.relations)) out[`${name}Id`] = row[column] ?? null;
  return out;
}
function restrictRecord(ctx: Context, value: Row): Row {
  for (const field of ctx.readDenied) delete value[field];
  return value;
}
async function record(ctx: Context, row: Row, includeInverse = true): Promise<Row> {
  const out = restrictRecord(ctx, baseRecord(ctx.entity, row, ctx.custom));
  for (const [name, [column, table]] of Object.entries(ctx.entity.relations)) {
    const entity = entities.find(item => item.table === table);
    const related = row[column] ? await ctx.env.CRM_DB!.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? AND id = ?${entity ? ' AND deleted_at IS NULL' : ''}`).bind(ctx.workspaceId, row[column]).first<Row>() : null;
    out[name] = related ? entity ? baseRecord(entity, related, customFor(ctx.allCustom, entity)) : { __typename: 'Pipeline', id: related.id, name: related.name } : null;
  }
  if (includeInverse) {
    const inverse: [string, string, string][] = ctx.entity.singular === 'person' ? [['opportunities', 'opportunities', 'point_of_contact_id'], ['activities', 'activities', 'contact_id']] : ctx.entity.singular === 'company' ? [['opportunities', 'opportunities', 'company_id'], ['activities', 'activities', 'company_id']] : ctx.entity.singular === 'opportunity' ? [['activities', 'activities', 'opportunity_id']] : [];
    for (const [name, table, column] of inverse) {
      const entity = entities.find(item => item.table === table)!;
      const rows = await ctx.env.CRM_DB!.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? AND ${column} = ? AND deleted_at IS NULL ORDER BY created_at DESC, id ASC LIMIT 100`).bind(ctx.workspaceId, row.id).all<Row>();
      const count = await ctx.env.CRM_DB!.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ? AND ${column} = ? AND deleted_at IS NULL`).bind(ctx.workspaceId, row.id).first<{count: number}>();
      out[name] = connection(entity, rows.results.map(item => baseRecord(entity, item, customFor(ctx.allCustom, entity))), Number(count?.count ?? 0));
    }
  }
  return out;
}

function customValue(field: CustomField, value: unknown): Scalar | boolean {
  if (value === null) return null;
  if (field.field_type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return bad(`Invalid ${field.field_key}`);
  if (field.field_type === 'boolean' && typeof value !== 'boolean') return bad(`Invalid ${field.field_key}`);
  if (['text', 'date', 'select'].includes(field.field_type) && typeof value !== 'string') return bad(`Invalid ${field.field_key}`);
  if (field.field_type === 'date' && !Number.isFinite(Date.parse(String(value)))) return bad(`Invalid ${field.field_key}`);
  if (field.field_type === 'select' && field.options_json) {
    const options = JSON.parse(field.options_json) as unknown[];
    if (!Array.isArray(options) || !options.some(option => option === value || object(option) && option.value === value)) return bad(`Invalid ${field.field_key} option`);
  }
  if (typeof value === 'string' && value.length > 10000) return bad(`Field ${field.field_key} is too long`);
  return typeof value === 'boolean' ? value : scalar(value);
}
function valuesFor(ctx: Context, input: unknown, create: boolean): { values: Row; custom: Row } {
  if (!object(input)) return bad('A record input is required');
  const values: Row = create ? ctx.entity.singular === 'person' ? { first_name: '', last_name: '' } : ctx.entity.singular === 'activity' ? { title: '', type: 'task' } : ctx.entity.singular === 'opportunity' ? { name: '', stage: 'prospecting' } : ctx.entity.singular === 'blocklist' ? { handle: '', scope: 'WORKSPACE' } : { name: '' } : {};
  const custom: Row = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'id') { if (!create) return bad('Record ID cannot be updated'); continue; }
    if (key === '__typename') continue;
    if (ctx.writeDenied.has(key)) return bad(`Field update denied: ${key}`, 403);
    if (['createdAt', 'updatedAt', 'deletedAt', 'ownerSubject', 'workspaceId', 'workspace_id'].includes(key)) return bad(`Field ${key} is server-managed`);
    if (key === 'name' && ctx.entity.singular === 'person') {
      if (!object(value) || Object.keys(value).some(key => !['firstName', 'lastName', '__typename'].includes(key))) return bad('name must contain firstName and lastName');
      for (const [part, column] of [['firstName', 'first_name'], ['lastName', 'last_name']]) if (value[part] !== undefined) {
        if (typeof value[part] !== 'string' || (value[part] as string).length > 500) return bad('Invalid full name'); values[column] = value[part];
      }
      continue;
    }
    const relation = Object.entries(ctx.entity.relations).find(([name]) => key === name || key === `${name}Id`);
    if (relation) {
      let relationId = value;
      if (object(value)) {
        if (object(value.connect)) relationId = value.connect.id;
        else if (value.disconnect === true) relationId = null;
        else return bad('A relationship must connect an ID or disconnect');
      }
      if (relationId !== null && (typeof relationId !== 'string' || relationId.length > 100 || !relationId)) return bad('Invalid relationship ID');
      values[relation[1][0]] = relationId; continue;
    }
    const customField = ctx.custom.find(field => field.field_key === key);
    if (customField) { custom[key] = customValue(customField, value); continue; }
    const column = ctx.entity.fields[key];
    if (!column) return bad(`Unsupported writable field: ${key}`);
    if (value !== null && typeof value !== 'string' && !['amount', 'amountCents'].includes(key)) return bad(`Invalid value for ${key}`);
    if (typeof value === 'string' && value.length > (key === 'body' ? 50000 : 10000)) return bad(`Field ${key} is too long`);
    if (['firstName', 'lastName', 'name', 'title', 'type', 'stage', 'handle', 'scope'].includes(key) && value === null) return bad(`${key} cannot be null`);
    if (['dueAt', 'completedAt'].includes(key) && value !== null && !Number.isFinite(Date.parse(String(value)))) return bad(`Invalid ${key}`);
    if (key === 'type' && !['note', 'task', 'call', 'email'].includes(String(value))) return bad('Invalid activity type');
    if (key === 'scope' && value !== 'WORKSPACE') return bad('Invalid blocklist scope');
    if (key === 'handle' && (typeof value !== 'string' || !value.trim() || value.length > 320)) return bad('Invalid blocklist handle');
    if (key === 'amountCents' && value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value))) return bad('amountCents must be an integer');
    values[column] = fieldScalar(key, value);
  }
  return { values, custom };
}
async function validateRelations(ctx: Context, values: Row): Promise<void> {
  for (const [column, table] of Object.values(ctx.entity.relations)) if (values[column] !== undefined && values[column] !== null) {
    const target = await ctx.env.CRM_DB!.prepare(`SELECT id FROM ${table} WHERE workspace_id = ? AND id = ?${table !== 'pipelines' ? ' AND deleted_at IS NULL' : ''}`).bind(ctx.workspaceId, values[column]).first();
    if (!target) throw new ContractError('Related record is not available in this workspace', 400);
  }
}
function valueSql(ctx: Context, column: string, value: unknown, params: Scalar[]): string {
  const relation = Object.values(ctx.entity.relations).find(([key]) => key === column);
  if (relation && value !== null) {
    params.push(ctx.workspaceId, scalar(value), scalar(value));
    // Recheck ownership inside the write; invalid JSON aborts the entire D1 batch
    // if a relationship was deleted between validation and the atomic commit.
    return `CASE WHEN EXISTS (SELECT 1 FROM ${relation[1]} WHERE workspace_id = ? AND id = ?${relation[1] !== 'pipelines' ? ' AND deleted_at IS NULL' : ''}) THEN ? ELSE json('invalid-reference') END`;
  }
  params.push(scalar(value)); return '?';
}
async function writeStatement(ctx: Context, input: unknown, id: string | string[], create: boolean, actor: string): Promise<D1PreparedStatement> {
  const { values, custom } = valuesFor(ctx, input, create);
  await validateRelations(ctx, values);
  const now = new Date().toISOString();
  const params: Scalar[] = [];
  if (create) {
    if (Array.isArray(id)) return bad('Create requires a single record ID');
    const all = { id, workspace_id: ctx.workspaceId, ...values, custom_fields_json: JSON.stringify(custom), owner_subject: actor, created_at: now, updated_at: now };
    return ctx.env.CRM_DB!.prepare(`INSERT INTO ${ctx.entity.table} (${Object.keys(all).join(',')}) VALUES (${Object.entries(all).map(([key, value]) => valueSql(ctx, key, value, params)).join(',')})`).bind(...params);
  }
  const assignments = Object.entries(values).map(([column, value]) => `${column} = ${valueSql(ctx, column, value, params)}`);
  if (Object.keys(custom).length) { assignments.push('custom_fields_json = json_patch(custom_fields_json, ?)'); params.push(JSON.stringify(custom)); }
  const ids = Array.isArray(id) ? id : [id];
  assignments.push('updated_at = ?'); params.push(now, ctx.workspaceId, ...ids);
  return ctx.env.CRM_DB!.prepare(`UPDATE ${ctx.entity.table} SET ${assignments.join(',')} WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL RETURNING *`).bind(...params);
}

async function aggregate(ctx: Context, query: string, predicate: {sql: string; params: Scalar[]}, totalCount: number): Promise<Row> {
  // Generated aggregate selections are flat scalar fields. Explicitly reject
  // fields outside this contract instead of reporting a successful empty value.
  const selection = new RegExp(`\\b${ctx.entity.plural}\\s*(?:\\([^{}]*\\))?\\s*\\{([^{}]*)\\}`).exec(query)?.[1] ?? 'totalCount';
  const fields = selection.match(/[A-Za-z_][A-Za-z0-9_]*(?:\s*:\s*[A-Za-z_][A-Za-z0-9_]*)?/g) ?? [];
  const data: Row = { __typename: `${cap(ctx.entity.singular)}Connection`, totalCount };
  const selects: string[] = [];
  for (const item of fields) {
    const [aliasOrField, aliasField] = item.split(/\s*:\s*/);
    const field = aliasField ?? aliasOrField;
    if (field === 'totalCount' || field === '__typename') { data[aliasOrField] = data[field]; continue; }
    const match = /^(countUniqueValues|countEmpty|countNotEmpty|percentageEmpty|percentageNotEmpty|countTrue|countFalse|sum|avg|min|max)([A-Z].*)$/.exec(field);
    if (!match) return bad(`Unsupported aggregate field: ${field}`);
    const operation = match[1], key = match[2][0].toLowerCase() + match[2].slice(1);
    let column = fieldExpression(ctx, key);
    if (key === 'name' && ctx.entity.singular === 'person') column = "(COALESCE(first_name, '') || COALESCE(last_name, ''))";
    const emptyColumn = `NULLIF(CAST(${column} AS TEXT), '')`;
    let expression: string;
    if (operation === 'countEmpty') expression = `COUNT(*) - COUNT(${emptyColumn})`;
    else if (operation === 'countNotEmpty') expression = `COUNT(${emptyColumn})`;
    else if (operation === 'countUniqueValues') expression = `COUNT(DISTINCT ${emptyColumn})`;
    else if (operation === 'percentageEmpty') expression = `(COUNT(*) - COUNT(${emptyColumn})) * 1.0 / COUNT(*)`;
    else if (operation === 'percentageNotEmpty') expression = `COUNT(${emptyColumn}) * 1.0 / COUNT(*)`;
    else if (operation === 'countTrue' || operation === 'countFalse') {
      if (!ctx.custom.some(f => f.field_key === key && f.field_type === 'boolean')) return bad('Boolean aggregate requires a boolean field');
      expression = `SUM(CASE WHEN ${column} = ${operation === 'countTrue' ? 1 : 0} THEN 1 ELSE 0 END)`;
    } else {
      const numeric = key === 'amount' || key === 'amountCents' || ctx.custom.some(f => f.field_key === key && f.field_type === 'number');
      const date = ['createdAt', 'updatedAt', 'deletedAt', 'dueAt', 'completedAt'].includes(key) || ctx.custom.some(f => f.field_key === key && f.field_type === 'date');
      if (!numeric && !(date && ['min', 'max'].includes(operation))) return bad('Unsupported aggregate for this field type');
      expression = `${operation.toUpperCase()}(${column})${key === 'amount' ? ' / 100.0' : ''}`;
    }
    selects.push(`CASE WHEN COUNT(*) = 0 THEN NULL ELSE ${expression} END AS "${aliasOrField}"`);
  }
  if (selects.length > 50) return bad('Too many aggregate fields');
  if (selects.length) Object.assign(data, await ctx.env.CRM_DB!.prepare(`SELECT ${selects.join(',')} FROM ${ctx.entity.table} WHERE ${predicate.sql}`).bind(...predicate.params).first<Row>());
  return data;
}

/** Exact upstream-generated operations only. Caller must authorize membership first.
 * Returns null for unrelated operations so metadata/auth dispatch remains separate. */
export async function crmRecords(op: string, query: string, variables: Row, env: Env, workspaceId: string, role: string, actorSubject: string): Promise<Response | null> {
  const match = /^(FindMany|FindOne|Aggregate|CreateOne|CreateMany|UpdateOne|UpdateMany|DeleteOne|DeleteMany|DestroyOne|DestroyMany|RestoreOne|RestoreMany)(Person|People|Company|Companies|Opportunity|Opportunities|Activity|Activities|Blocklist|Blocklists)$/.exec(op);
  if (!match) return null;
  const action = match[1];
  const entity = entities.find(item => cap(item.singular) === match[2] || cap(item.plural) === match[2])!;
  const root = action === 'FindOne' ? entity.singular : action === 'FindMany' || action === 'Aggregate' ? entity.plural : `${action.replace(/One|Many/, '').toLowerCase()}${cap(action.endsWith('Many') ? entity.plural : entity.singular)}`;
  try {
    // Variable declarations precede the selection set. Reject a known operation
    // carrying a different root rather than silently execute it as a mutation.
    const selected = /\{\s*(\w+)\s*(?::\s*(\w+))?/.exec(query.replace(/#[^\n]*/g, ''));
    if (query && (!selected || (selected[2] ?? selected[1]) !== root)) return bad('GraphQL operation/root mismatch');
    const responseKey = selected?.[2] ? selected[1] : root;
    const right: Right = action.startsWith('Create') ? 'create' : action.startsWith('Update') ? 'update' : /^(Delete|Destroy|Restore)/.test(action) ? 'delete' : 'read';
    const permissions = await crmPermissions(env, workspaceId, role, entity.singular);
    if (!permissions[right]) throw new ContractError(`Not authorized to ${right} records`, 403);
    const custom = await env.CRM_DB!.prepare('SELECT id, object_type, field_key, field_type, options_json FROM custom_fields WHERE workspace_id = ?').bind(workspaceId).all<CustomField>();
    const entityCustom = customFor(custom.results, entity);
    const controls = await roleControls(env,workspaceId,role,entity,entityCustom,actorSubject);
    const ctx: Context = { env, workspaceId, entity, custom: entityCustom, allCustom: custom.results, ...controls };
    const success = (value: unknown) => Response.json({ data: { [responseKey]: value } });
    const oneRow = (id: string, deleted = false) => env.CRM_DB!.prepare(`SELECT * FROM ${entity.table} WHERE workspace_id = ? AND id = ?${deleted ? '' : ' AND deleted_at IS NULL'} AND (${ctx.rowSql})`).bind(workspaceId, id, ...ctx.rowParams).first<Row>();
    if (action === 'FindMany' || action === 'Aggregate') {
      const predicate = where(ctx, variables.filter);
      const count = await env.CRM_DB!.prepare(`SELECT COUNT(*) AS count FROM ${entity.table} WHERE ${predicate.sql}`).bind(...predicate.params).first<{count: number}>();
      const totalCount = Number(count?.count ?? 0);
      if (action === 'Aggregate') return success(await aggregate(ctx, query, predicate, totalCount));
      let limit = Number(variables.first ?? variables.last ?? variables.limit ?? 30);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) return bad('Page size must be between 1 and 100');
      let offset = Number(variables.offset ?? 0);
      if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) return bad('Invalid offset');
      const after = variables.after ?? (/before\s*:/.test(query) ? undefined : variables.lastCursor);
      const before = variables.before ?? (/before\s*:/.test(query) ? variables.lastCursor : undefined);
      if (after && before) return bad('Cannot combine forward and backward cursors');
      if (after) offset += cursorOffset(after) + 1;
      if (before) { const end = cursorOffset(before); offset = Math.max(0, end - limit); limit = Math.min(limit, end); }
      else if (variables.last !== undefined || /last\s*:/.test(query)) offset = Math.max(0, totalCount - limit - offset);
      const rows = await env.CRM_DB!.prepare(`SELECT * FROM ${entity.table} WHERE ${predicate.sql} ORDER BY ${orderSql(ctx, variables.orderBy)} LIMIT ? OFFSET ?`).bind(...predicate.params, limit, offset).all<Row>();
      return success(connection(entity, await Promise.all(rows.results.map(row => record(ctx, row))), totalCount, offset));
    }
    const input = variables.input ?? variables.data;
    if (action.startsWith('Create')) {
      const inputs = action === 'CreateMany' ? input : [input];
      if (!Array.isArray(inputs) || !inputs.length || inputs.length > 50) return bad('Create requires 1 to 50 records');
      const ids = inputs.map(item => {
        if (!object(item)) return bad('Invalid record input');
        if (item.id !== undefined && (typeof item.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id))) return bad('A valid UUID is required');
        return String(item.id ?? crypto.randomUUID());
      });
      const statements = await Promise.all(inputs.map((item, index) => writeStatement(ctx, item, ids[index], true, actorSubject)));
      await env.CRM_DB!.batch(statements);
      const rows = await Promise.all(ids.map(async id => record(ctx, (await oneRow(id))!)));
      return success(action === 'CreateOne' ? rows[0] : rows);
    }
    if (action.endsWith('Many')) {
      if (!object(variables.filter) || !Object.keys(variables.filter).length) return bad('Bulk mutations require an explicit filter');
      const predicate = where(ctx, variables.filter, /^(Restore|Destroy)/.test(action) ? 'deleted' : 'active');
      // User filters may request trash, but must never turn Destroy into a
      // permanent deletion of live records or Update into a write to trash.
      if (/^(Restore|Destroy)/.test(action)) predicate.sql += ' AND deleted_at IS NOT NULL';
      else predicate.sql += ' AND deleted_at IS NULL';
      const rows = await env.CRM_DB!.prepare(`SELECT * FROM ${entity.table} WHERE ${predicate.sql} LIMIT 51`).bind(...predicate.params).all<Row>();
      if (rows.results.length > 50) return bad('Bulk mutations are limited to 50 records');
      if (!rows.results.length) return success([]);
      let changed: Row[];
      if (action === 'UpdateMany') {
        // One atomic UPDATE rechecks lifecycle for every selected ID. RETURNING
        // reports only rows actually changed, never records concurrently trashed.
        const statement = await writeStatement(ctx, input, rows.results.map(row => String(row.id)), false, actorSubject);
        changed = (await statement.all<Row>()).results;
      } else {
        const ids = rows.results.map(row => scalar(row.id));
        const lifecycle = action === 'DestroyMany' ? `DELETE FROM ${entity.table}` : `UPDATE ${entity.table} SET deleted_at = ?, updated_at = ?`;
        const now = new Date().toISOString();
        const sourceLifecycle = action === 'DeleteMany' ? 'IS NULL' : 'IS NOT NULL';
        changed = (await env.CRM_DB!.prepare(`${lifecycle} WHERE workspace_id = ? AND id IN (${ids.map(() => '?').join(',')}) AND deleted_at ${sourceLifecycle} RETURNING *`).bind(...(action === 'DestroyMany' ? [] : [action === 'RestoreMany' ? null : now, now]), workspaceId, ...ids).all<Row>()).results;
      }
      return success(await Promise.all(changed.map(row => action === 'DestroyMany' ? baseRecord(entity, row, ctx.custom) : record(ctx, row))));
    }
    const id = variables.objectRecordId ?? variables.idToFind ?? variables.idToUpdate ?? variables.idToDelete ?? variables.idToDestroy ?? variables.idToRestore ?? variables.id;
    if (typeof id !== 'string' || !id || id.length > 100) return bad('Record ID is required');
    const includeDeleted = /^(Delete|Destroy|Restore)/.test(action) || action === 'FindOne' && /deletedAt\s*:/.test(query);
    const row = await oneRow(id, includeDeleted);
    if (!row) {
      if (action === 'FindOne') return success(null);
      throw new ContractError('Record not found in this workspace', 404);
    }
    if (action === 'FindOne') return success(await record(ctx, row));
    let changed: Row[];
    if (action === 'UpdateOne') changed = (await (await writeStatement(ctx, input, id, false, actorSubject)).all<Row>()).results;
    else if (action === 'DestroyOne') {
      if (!row.deleted_at) return bad('Move a record to trash before destroying it');
      changed = (await env.CRM_DB!.prepare(`DELETE FROM ${entity.table} WHERE workspace_id = ? AND id = ? AND deleted_at IS NOT NULL RETURNING *`).bind(workspaceId, id).all<Row>()).results;
      if (!changed.length) throw new ContractError('Record lifecycle changed. Refresh and retry.', 409);
      return success(baseRecord(entity, changed[0], ctx.custom));
    } else {
      const now = new Date().toISOString();
      changed = (await env.CRM_DB!.prepare(`UPDATE ${entity.table} SET deleted_at = ?, updated_at = ? WHERE workspace_id = ? AND id = ? AND deleted_at ${action === 'RestoreOne' ? 'IS NOT NULL' : 'IS NULL'} RETURNING *`).bind(action === 'RestoreOne' ? null : now, now, workspaceId, id).all<Row>()).results;
    }
    if (!changed.length) throw new ContractError('Record lifecycle changed. Refresh and retry.', 409);
    return success(await record(ctx, changed[0]));
  } catch (error) {
    if (error instanceof ContractError) return Response.json({ errors: [{ message: error.message, extensions: { code: error.status === 403 ? 'FORBIDDEN' : 'BAD_USER_INPUT' } }] }, { status: error.status });
    // Avoid returning SQL, tenant IDs, record contents or database internals.
    return Response.json({ errors: [{ message: 'The record operation could not be committed. Refresh and retry.', extensions: { code: 'RECORD_CONFLICT' } }] }, { status: 409 });
  }
}
