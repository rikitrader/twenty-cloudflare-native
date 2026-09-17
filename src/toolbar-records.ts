import type { Env } from './types';
import { crmPermissions, crmSortDirection } from './crm-records';

type Row = Record<string, unknown>;
const isObject = (value: unknown): value is Row => !!value && typeof value === 'object' && !Array.isArray(value);
const statusSql = "CASE status WHEN 'draft' THEN 'DRAFT' WHEN 'active' THEN 'ACTIVE' WHEN 'inactive' THEN 'DEACTIVATED' WHEN 'discarded' THEN 'ARCHIVED' ELSE status END";
const columns: Record<string, string> = { id: 'id', workflowId: 'id', name: 'name', status: statusSql, createdAt: 'created_at', updatedAt: 'updated_at', deletedAt: 'NULL' };
class InvalidContract extends Error {}
const fail = (message: string): never => { throw new InvalidContract(message); };
const scalar = (value: unknown): string | null => typeof value === 'string' || value === null ? value : fail('Invalid workflow-version filter value');
function where(input: unknown, values: (string | null)[], depth = 0): string {
  if (input === undefined || input === null) return '1 = 1';
  if (!isObject(input) || depth > 6 || values.length > 75) return fail('Invalid workflow-version filter');
  const clauses: string[] = [];
  for (const [key, condition] of Object.entries(input)) {
    if (key === 'and' || key === 'or') {
      if (!Array.isArray(condition) || condition.length > 50) return fail('Invalid workflow-version filter group');
      clauses.push(condition.length ? `(${condition.map(item => where(item, values, depth + 1)).join(key === 'and' ? ' AND ' : ' OR ')})` : key === 'and' ? '1 = 1' : '0 = 1'); continue;
    }
    if (key === 'not') { clauses.push(`NOT (${where(condition, values, depth + 1)})`); continue; }
    const column = columns[key];
    if (!column || !isObject(condition)) return fail('Unsupported workflow-version filter field');
    for (const [operator, value] of Object.entries(condition)) {
      if (operator === 'eq' || operator === 'neq') {
        if (value === null) clauses.push(`${column} IS ${operator === 'neq' ? 'NOT ' : ''}NULL`);
        else { clauses.push(`${column} ${operator === 'eq' ? '=' : '<>'} ?`); values.push(scalar(value)); }
      } else if (operator === 'in') {
        if (!Array.isArray(value) || value.length > 60) return fail('Invalid workflow-version ID list');
        clauses.push(value.length ? `${column} IN (${value.map(() => '?').join(',')})` : '0 = 1'); values.push(...value.map(scalar));
      } else if (operator === 'is' && ['NULL','NOT_NULL',null].includes(value as never)) clauses.push(`${column} IS ${value === 'NOT_NULL' ? 'NOT ' : ''}NULL`);
      else return fail('Unsupported workflow-version filter operator');
    }
  }
  if (values.length > 80) return fail('Workflow-version filter exceeds the parameter limit');
  return clauses.length ? clauses.map(clause => `(${clause})`).join(' AND ') : '1 = 1';
}
function version(row: Row): Row {
  // native_workflows has one mutable definition, not a version-history table.
  // Expose that one stored definition under its persisted ID as an internal view.
  const statuses: Record<string, string> = { draft:'DRAFT', active:'ACTIVE', inactive:'DEACTIVATED', discarded:'ARCHIVED' };
  const status = statuses[String(row.status)];
  if (!status) return fail('Stored native workflow status cannot be represented');
  let definition: unknown;
  try { definition = JSON.parse(String(row.definition_json)); } catch { return fail('Stored workflow definition is invalid'); }
  if (!isObject(definition)) return fail('Stored workflow definition must be an object');
  if (definition.trigger != null && !isObject(definition.trigger)) return fail('Stored workflow trigger is invalid');
  if (definition.steps != null && !Array.isArray(definition.steps)) return fail('Stored workflow steps are invalid');
  return { __typename:'WorkflowVersion',id:row.id,workflowId:row.id,name:row.name,status,createdAt:row.created_at,updatedAt:row.updated_at,deletedAt:null,trigger:definition.trigger ?? null,steps:definition.steps ?? null };
}
function workflow(row: Row): Row {
  const current = version(row);
  return { __typename:'Workflow',id:row.id,name:row.name,description:row.description ?? null,
    createdAt:row.created_at,updatedAt:row.updated_at,deletedAt:null,
    statuses:current.status === 'ARCHIVED' ? [] : [current.status],lastPublishedVersionId:current.status === 'ACTIVE' ? current.id : null,
    versions:{__typename:'WorkflowVersionConnection',nodes:[current],edges:[{__typename:'WorkflowVersionEdge',node:current,cursor:String(current.id)}],totalCount:1,pageInfo:{__typename:'PageInfo',hasNextPage:false,hasPreviousPage:false,startCursor:String(current.id),endCursor:String(current.id)}} };
}

/** Read-only internal dependency of Twenty's command toolbar. The caller must
 * validate active workspace membership; this additionally enforces CRM read
 * permission and includes workspace_id on every database query. */
export async function toolbarRecords(op: string, query: string, vars: Row, env: Env, workspaceId: string, role: string): Promise<Response | null> {
  const read = ['FindOneWorkflowVersion','FindManyWorkflowVersions','AggregateWorkflowVersions','GetWorkflowVersionContent','FindOneWorkflow','FindManyWorkflows','AggregateWorkflows'].includes(op);
  const unsupportedWrite = /^(Create|Update|Delete|Destroy|Restore)(One|Many)Workflow(?:Version)?s?$/.test(op);
  if (!read && !unsupportedWrite) return null;
  if (unsupportedWrite) return Response.json({ errors:[{message:'Workflow-version editing is not supported by the native current-definition view.',extensions:{code:'NOT_IMPLEMENTED'}}] },{status:501});
  if (!(await crmPermissions(env, workspaceId, role)).read) return Response.json({errors:[{message:'Not authorized to read workflow definitions',extensions:{code:'FORBIDDEN'}}]},{status:403});
  try {
    const entity = op.includes('WorkflowVersion') ? 'workflowVersion' : 'workflow';
    const typename = entity === 'workflowVersion' ? 'WorkflowVersion' : 'Workflow';
    const mapRow = (row: Row) => entity === 'workflow' ? workflow(row) : { ...version(row),workflow:workflow(row) };
    const root = op === 'GetWorkflowVersionContent' ? 'workflowVersionContent' : op.startsWith('FindOne') ? entity : `${entity}s`;
    const selected = /\{\s*(\w+)\s*(?::\s*(\w+))?/.exec(query.replace(/#[^\n]*/g,''));
    if (query && (!selected || (selected[2] ?? selected[1]) !== root)) return fail('Workflow-version operation/root mismatch');
    const responseRoot = selected?.[2] ? selected[1] : root;
    const success = (value: unknown) => Response.json({data:{[responseRoot]:value}});
    if (op.startsWith('FindOne') || op === 'GetWorkflowVersionContent') {
      const id = vars.workflowVersionId ?? vars.objectRecordId ?? vars.id;
      if (typeof id !== 'string' || !id || id.length > 100) return fail('A workflow-version ID is required');
      const row = await env.CRM_DB!.prepare('SELECT * FROM native_workflows WHERE workspace_id = ? AND id = ?').bind(workspaceId,id).first<Row>();
      if (!row) return success(null);
      const current = version(row);
      return success(op.startsWith('FindOne') ? mapRow(row) : {__typename:'WorkflowVersionContent',workflowVersionId:current.id,trigger:current.trigger,steps:current.steps});
    }
    const values: (string | null)[] = [workspaceId];
    const predicate = `workspace_id = ? AND (${where(vars.filter,values)})`;
    const count = await env.CRM_DB!.prepare(`SELECT COUNT(*) AS count FROM native_workflows WHERE ${predicate}`).bind(...values).first<{count:number}>();
    const totalCount = Number(count?.count ?? 0);
    if (op.startsWith('Aggregate')) return success({__typename:`${typename}Connection`,totalCount});
    const limit = Number(vars.limit ?? vars.first ?? 50);
    let offset = Number(vars.offset ?? 0);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0 || offset > 1000000) return fail('Invalid workflow-version pagination');
    if (/before\s*:|last\s*:/.test(query) || vars.before != null || vars.last != null) return fail('Backward workflow-version pagination is not supported');
    const after = vars.lastCursor ?? vars.after;
    if (after != null) {
      let parsed: unknown;
      try { parsed = JSON.parse(atob(String(after))); } catch { return fail('Invalid workflow-version cursor'); }
      if (!isObject(parsed) || parsed.type !== entity || !Number.isInteger(parsed.offset) || Number(parsed.offset)<0 || Number(parsed.offset)>1000000) return fail('Invalid workflow-version cursor');
      offset += Number(parsed.offset) + 1;
    }
    const order: string[] = [];
    if (vars.orderBy !== undefined && vars.orderBy !== null) {
      if (!Array.isArray(vars.orderBy) || vars.orderBy.length > 8) return fail('Invalid workflow-version orderBy');
      for (const item of vars.orderBy) {
        if (!isObject(item)) return fail('Invalid workflow-version orderBy');
        for (const [field, direction] of Object.entries(item)) {
          const sqlDirection = crmSortDirection(direction);
          if (!columns[field] || !sqlDirection) return fail('Invalid workflow-version sort');
          order.push(`${columns[field]} ${sqlDirection}`);
        }
      }
    }
    if (!order.length) order.push('updated_at DESC');
    order.push('id ASC');
    const rows = await env.CRM_DB!.prepare(`SELECT * FROM native_workflows WHERE ${predicate} ORDER BY ${order.join(',')} LIMIT ? OFFSET ?`).bind(...values,limit,offset).all<Row>();
    const nodes = rows.results.map(mapRow);
    const cursor = (offset: number) => btoa(JSON.stringify({type:entity,offset}));
    return success({__typename:`${typename}Connection`,nodes,totalCount,edges:nodes.map((node,index)=>({__typename:`${typename}Edge`,node,cursor:cursor(offset+index)})),pageInfo:{__typename:'PageInfo',hasNextPage:offset+nodes.length<totalCount,hasPreviousPage:offset>0,startCursor:nodes.length?cursor(offset):null,endCursor:nodes.length?cursor(offset+nodes.length-1):null}});
  } catch (error) {
    return Response.json({errors:[{message:error instanceof InvalidContract ? error.message : 'Workflow definitions could not be loaded',extensions:{code:error instanceof InvalidContract ? 'BAD_USER_INPUT' : 'INTERNAL_SERVER_ERROR'}}]},{status:error instanceof InvalidContract ? 400 : 500});
  }
}
