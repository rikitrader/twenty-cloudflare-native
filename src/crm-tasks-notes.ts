import type { Env } from './types';
import { crmPermissions } from './crm-records';
import { dispatchMutationLedger, mutationLedger } from './crm-mutation-ledger';

type Vars = Record<string, unknown>;
type Row = Record<string, any>;
const obj = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const input = (vars: Vars): Record<string, unknown> => obj(vars.input) ? obj(vars.input.data) ? vars.input.data : vars.input : obj(vars.data) ? vars.data : {};
const root = (query: string, fallback: string) => query.match(/\{\s*([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? fallback;
const cap = (value: string) => value[0].toUpperCase() + value.slice(1);
const connection = (type: string, nodes: Row[], totalCount: number, offset: number) => ({ __typename: `${type}Connection`, nodes, edges: nodes.map((node, index) => ({ node, cursor: btoa(String(offset+index)) })), totalCount, pageInfo: { hasNextPage: offset+nodes.length<totalCount, hasPreviousPage: offset>0, startCursor: nodes.length ? btoa(String(offset)) : null, endCursor: nodes.length ? btoa(String(offset+nodes.length-1)) : null } });
const page = (vars: Vars) => { const limit=Number(vars.first??vars.limit??30); if(!Number.isInteger(limit)||limit<1||limit>100) throw new Error('INVALID_PAGE_SIZE'); let offset=Number(vars.offset??0); if(!Number.isInteger(offset)||offset<0||offset>1_000_000) throw new Error('INVALID_CURSOR'); if(vars.after!==undefined){if(typeof vars.after!=='string')throw new Error('INVALID_CURSOR');const decoded=Number(atob(vars.after));if(!Number.isInteger(decoded)||decoded<0)throw new Error('INVALID_CURSOR');offset+=decoded+1;}return{limit,offset};};
const activityId = (vars: Vars) => vars.objectRecordId ?? vars.idToFind ?? vars.idToUpdate ?? vars.idToDelete ?? vars.idToRestore ?? vars.idToDestroy ?? vars.id;
const parseBody = (value: unknown) => { try { return typeof value === 'string' ? JSON.parse(value) : value ?? null; } catch { return null; } };
const actorValue = (subject: string) => ({ source: 'MANUAL', workspaceMemberId: subject, name: subject });

function activity(row: Row, kind: 'task' | 'note'): Row {
  return { __typename: cap(kind), id: row.id, position: row.position, title: row.title, bodyV2: parseBody(row.body_v2_json),
    ...(kind === 'task' ? { dueAt: row.due_at, status: row.status, assigneeId: row.assignee_subject, assignee: row.assignee_subject ? { __typename: 'WorkspaceMember', id: row.assignee_subject, name: { firstName: row.assignee_subject, lastName: '' } } : null } : {}),
    attachments: [], createdBy: actorValue(row.created_by), updatedBy: actorValue(row.updated_by), createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at };
}

const targetFields = { targetPersonId: ['person', 'contacts'], targetCompanyId: ['company', 'companies'], targetOpportunityId: ['opportunity', 'opportunities'] } as const;
function targetValue(row: Row, kind: 'task' | 'note', source?: Row): Row {
  const join = `target${cap(row.target_type)}Id`;
  return { __typename: `${cap(kind)}Target`, id: row.id, [`${kind}Id`]: row[`${kind}_id`], [kind]: source ? activity(source, kind) : null, [join]: row.target_id,
    createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at };
}

async function commit(env: Env, workspaceId: string, actor: string, action: string, type: string, id: string, statements: D1PreparedStatement[], metadata: Record<string, unknown> = {}) {
  const ledger = mutationLedger(env, workspaceId, actor, action, type, id, metadata);
  await env.CRM_DB!.batch([...statements, ...ledger.statements]);
  await dispatchMutationLedger(env, ledger);
}

export async function crmTasksNotes(operation: string, query: string, vars: Vars, env: Env, workspaceId: string, role: string, actor: string): Promise<Response | null> {
  const match = operation.match(/^(FindMany|FindOne|CreateOne|CreateMany|UpdateOne|DeleteOne|RestoreOne|DestroyOne)(Tasks|Task|Notes|Note|TaskTargets|TaskTarget|NoteTargets|NoteTarget)$/i);
  if (!match) return null;
  const action = match[1]; const token = match[2].toLowerCase(); const target = token.includes('target'); const kind: 'task' | 'note' = token.startsWith('task') ? 'task' : 'note';
  const table = target ? `crm_${kind}_targets` : `crm_${kind}s`; const typename = `${cap(kind)}${target ? 'Target' : ''}`;
  const permissions = await crmPermissions(env, workspaceId, role, target ? `${kind}Target` : kind); const required = action.startsWith('Find') ? 'read' : action.startsWith('Create') ? 'create' : action.startsWith('Update') || action.startsWith('Restore') ? 'update' : 'delete';
  if (!permissions[required]) return Response.json({ errors: [{ message: `${cap(required)} access denied`, extensions: { code: 'FORBIDDEN' } }] }, { status: 403 });
  const fallback = action === 'FindMany' ? `${kind}${target ? 'Targets' : 's'}` : action === 'FindOne' ? `${kind}${target ? 'Target' : ''}` : `${action[0].toLowerCase()}${action.slice(1)}${typename}`;
  const field = root(query, fallback); const ok = (value: unknown) => Response.json({ data: { [field]: value } });
  try {
    if (action === 'FindMany') {
      const {limit,offset}=page(vars);
      if (!target) {
        const [rows,count] = await Promise.all([env.CRM_DB!.prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND deleted_at IS NULL ORDER BY created_at DESC,id LIMIT ? OFFSET ?`).bind(workspaceId,limit,offset).all<Row>(),env.CRM_DB!.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id=? AND deleted_at IS NULL`).bind(workspaceId).first<{count:number}>()]);
        return ok(connection(typename, rows.results.map(row => activity(row, kind)),Number(count?.count??0),offset));
      }
      const filter = obj(vars.filter) ? vars.filter : {}; const groups = Array.isArray(filter.or) ? filter.or.filter(obj) : [filter];
      const predicates: {type:string;id:string}[] = [];
      for (const group of groups) for (const [name, [type]] of Object.entries(targetFields)) if (obj(group[name]) && typeof group[name].eq === 'string') predicates.push({ type, id: String(group[name].eq) });
      if (!predicates.length || predicates.length > 20) return Response.json({ errors: [{ message: 'A bounded target filter is required' }] }, { status: 400 });
      const clauses = predicates.map(() => '(t.target_type=? AND t.target_id=?)').join(' OR '); const binds = predicates.flatMap(item => [item.type, item.id]);
      const [rows,count] = await Promise.all([env.CRM_DB!.prepare(`SELECT t.*,s.* ,t.id as target_record_id,t.created_at as target_created_at,t.updated_at as target_updated_at,t.deleted_at as target_deleted_at FROM ${table} t JOIN crm_${kind}s s ON s.id=t.${kind}_id AND s.workspace_id=t.workspace_id WHERE t.workspace_id=? AND t.deleted_at IS NULL AND s.deleted_at IS NULL AND (${clauses}) ORDER BY s.created_at DESC,s.id LIMIT ? OFFSET ?`).bind(workspaceId, ...binds,limit,offset).all<Row>(),env.CRM_DB!.prepare(`SELECT COUNT(*) AS count FROM ${table} t JOIN crm_${kind}s s ON s.id=t.${kind}_id AND s.workspace_id=t.workspace_id WHERE t.workspace_id=? AND t.deleted_at IS NULL AND s.deleted_at IS NULL AND (${clauses})`).bind(workspaceId,...binds).first<{count:number}>()]);
      const nodes = rows.results.map(row => targetValue({ ...row, id: row.target_record_id, created_at: row.target_created_at, updated_at: row.target_updated_at, deleted_at: row.target_deleted_at }, kind, row));
      return ok(connection(typename, nodes,Number(count?.count??0),offset));
    }
    if (action === 'CreateOne' || action === 'CreateMany') {
      const entries = action === 'CreateMany' ? (Array.isArray(vars.input) ? vars.input : Array.isArray(vars.data) ? vars.data : []) : [input(vars)];
      if (!entries.length || entries.length > 50 || entries.some(item => !obj(item))) return Response.json({ errors: [{ message: 'Create requires 1 to 50 records' }] }, { status: 400 });
      const created: Row[] = [];
      for (const raw of entries as Record<string, unknown>[]) {
        const id = typeof raw.id === 'string' ? raw.id : crypto.randomUUID(); const now = new Date().toISOString();
        if (!target) {
          const title = typeof raw.title === 'string' ? raw.title.slice(0, 500) : kind === 'note' ? '' : null;
          const body = raw.bodyV2 == null ? null : obj(raw.bodyV2) ? JSON.stringify(raw.bodyV2) : null;
          if (raw.bodyV2 != null && !body) return Response.json({ errors: [{ message: 'bodyV2 must be a rich-text object' }] }, { status: 400 });
          const status = kind === 'task' && raw.status === 'DONE' ? 'DONE' : 'TODO'; const dueAt = kind === 'task' && typeof raw.dueAt === 'string' && Number.isFinite(Date.parse(raw.dueAt)) ? raw.dueAt : null;
          const assignee = kind === 'task' && typeof raw.assigneeId === 'string' ? raw.assigneeId : null;
          if (assignee && !(await env.CRM_DB!.prepare("SELECT 1 FROM workspace_members WHERE workspace_id=? AND identity_subject=? AND status='active'").bind(workspaceId, assignee).first())) return Response.json({ errors: [{ message: 'Assignee is not an active workspace member' }] }, { status: 400 });
          const statement = kind === 'task'
            ? env.CRM_DB!.prepare('INSERT INTO crm_tasks (id,workspace_id,position,title,body_v2_json,due_at,status,assignee_subject,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').bind(id, workspaceId, raw.position === 'last' ? Date.now() : Number(raw.position ?? 0), title, body, dueAt, status, assignee, actor, actor, now, now)
            : env.CRM_DB!.prepare('INSERT INTO crm_notes (id,workspace_id,position,title,body_v2_json,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(id, workspaceId, raw.position === 'last' ? Date.now() : Number(raw.position ?? 0), title, body, actor, actor, now, now);
          await commit(env, workspaceId, actor, 'create', kind, id, [statement]);
          created.push(activity((await env.CRM_DB!.prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND id=?`).bind(workspaceId, id).first<Row>())!, kind));
        } else {
          const sourceId = String(raw[`${kind}Id`] ?? ''); const targets = Object.entries(targetFields).filter(([name]) => typeof raw[name] === 'string');
          if (!sourceId || targets.length !== 1) return Response.json({ errors: [{ message: `A ${kind} and exactly one target are required` }] }, { status: 400 });
          const [targetName, [targetType, targetTable]] = targets[0]; const targetId = String(raw[targetName]);
          const [source, destination] = await Promise.all([env.CRM_DB!.prepare(`SELECT * FROM crm_${kind}s WHERE workspace_id=? AND id=? AND deleted_at IS NULL`).bind(workspaceId, sourceId).first<Row>(), env.CRM_DB!.prepare(`SELECT id FROM ${targetTable} WHERE workspace_id=? AND id=? AND deleted_at IS NULL`).bind(workspaceId, targetId).first()]);
          if (!source || !destination) return Response.json({ errors: [{ message: 'Source or target is not available in this workspace' }] }, { status: 400 });
          const statement = env.CRM_DB!.prepare(`INSERT INTO ${table} (id,workspace_id,${kind}_id,target_type,target_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id,${kind}_id,target_type,target_id) DO UPDATE SET deleted_at=NULL,updated_at=excluded.updated_at`).bind(id, workspaceId, sourceId, targetType, targetId, now, now);
          await commit(env, workspaceId, actor, 'link', `${kind}Target`, id, [statement], { sourceId, targetType, targetId });
          const stored = await env.CRM_DB!.prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND ${kind}_id=? AND target_type=? AND target_id=?`).bind(workspaceId, sourceId, targetType, targetId).first<Row>();
          created.push(targetValue(stored!, kind, source));
        }
      }
      return ok(action === 'CreateOne' ? created[0] : created);
    }
    const id = activityId(vars); if (typeof id !== 'string') return Response.json({ errors: [{ message: 'Record ID is required' }] }, { status: 400 });
    const existing = await env.CRM_DB!.prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND id=?`).bind(workspaceId, id).first<Row>();
    if (!existing) return action === 'FindOne' ? ok(null) : Response.json({ errors: [{ message: 'Record not found' }] }, { status: 404 });
    if (action === 'FindOne') return ok(target ? targetValue(existing, kind) : activity(existing, kind));
    const now = new Date().toISOString(); const statements: D1PreparedStatement[] = [];
    if (action === 'UpdateOne' && !target) {
      const raw = input(vars); const sets: string[] = ['updated_by=?', 'updated_at=?']; const binds: unknown[] = [actor, now];
      if (raw.title !== undefined) { if (typeof raw.title !== 'string') return Response.json({ errors: [{ message: 'Invalid title' }] }, { status: 400 }); sets.push('title=?'); binds.push(raw.title.slice(0, 500)); }
      if (raw.bodyV2 !== undefined) { if (raw.bodyV2 !== null && !obj(raw.bodyV2)) return Response.json({ errors: [{ message: 'Invalid bodyV2' }] }, { status: 400 }); sets.push('body_v2_json=?'); binds.push(raw.bodyV2 === null ? null : JSON.stringify(raw.bodyV2)); }
      if (kind === 'task' && raw.status !== undefined) { if (!['TODO', 'DONE'].includes(String(raw.status))) return Response.json({ errors: [{ message: 'Invalid task status' }] }, { status: 400 }); sets.push('status=?'); binds.push(raw.status); }
      if (kind === 'task' && raw.dueAt !== undefined) { if (raw.dueAt !== null && (typeof raw.dueAt !== 'string' || !Number.isFinite(Date.parse(raw.dueAt)))) return Response.json({ errors: [{ message: 'Invalid dueAt' }] }, { status: 400 }); sets.push('due_at=?'); binds.push(raw.dueAt); }
      statements.push(env.CRM_DB!.prepare(`UPDATE ${table} SET ${sets.join(',')} WHERE workspace_id=? AND id=? AND deleted_at IS NULL`).bind(...binds, workspaceId, id));
    } else if (action === 'DeleteOne') statements.push(env.CRM_DB!.prepare(`UPDATE ${table} SET deleted_at=?,updated_at=? WHERE workspace_id=? AND id=? AND deleted_at IS NULL`).bind(now, now, workspaceId, id));
    else if (action === 'RestoreOne') statements.push(env.CRM_DB!.prepare(`UPDATE ${table} SET deleted_at=NULL,updated_at=? WHERE workspace_id=? AND id=? AND deleted_at IS NOT NULL`).bind(now, workspaceId, id));
    else if (action === 'DestroyOne') { if (!existing.deleted_at) return Response.json({ errors: [{ message: 'Move the record to trash before destroying it' }] }, { status: 400 }); statements.push(env.CRM_DB!.prepare(`DELETE FROM ${table} WHERE workspace_id=? AND id=? AND deleted_at IS NOT NULL`).bind(workspaceId, id)); }
    else return Response.json({ errors: [{ message: 'Unsupported task/note operation' }] }, { status: 400 });
    await commit(env, workspaceId, actor, action.replace('One', '').toLowerCase(), target ? `${kind}Target` : kind, id, statements);
    if (action === 'DestroyOne') return ok(target ? targetValue(existing, kind) : activity(existing, kind));
    const changed = await env.CRM_DB!.prepare(`SELECT * FROM ${table} WHERE workspace_id=? AND id=?`).bind(workspaceId, id).first<Row>();
    return ok(target ? targetValue(changed!, kind) : activity(changed!, kind));
  } catch (error) {
    if(String(error).includes('INVALID_PAGE_SIZE')) return Response.json({errors:[{message:'Page size must be between 1 and 100'}]},{status:400});
    if(String(error).includes('INVALID_CURSOR')) return Response.json({errors:[{message:'Invalid cursor'}]},{status:400});
    console.error('Task/note operation failed', { operation, error: String(error) });
    return Response.json({ errors: [{ message: 'The task or note operation could not be committed', extensions: { code: 'RECORD_CONFLICT' } }] }, { status: 409 });
  }
}
