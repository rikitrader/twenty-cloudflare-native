import type { Env } from './types';
import { crmPermissions } from './crm-records';

type Vars = Record<string, unknown>;
type Row = Record<string, any>;

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const rootField = (query: string): string | null => query.match(/\{\s*([A-Za-z_][A-Za-z0-9_]*)/)?.[1] ?? null;
const inputFor = (variables: Vars): Record<string, unknown> => {
  const input = variables.input ?? variables.data;
  return object(input) ? object(input.data) ? input.data : input : {};
};
const targetFields = {
  targetPersonId: ['person', 'contacts'],
  targetCompanyId: ['company', 'companies'],
  targetOpportunityId: ['opportunity', 'opportunities'],
  targetActivityId: ['activity', 'activities'],
  targetTaskId: ['task', 'activities'],
  targetNoteId: ['note', 'activities'],
} as const;
const cap = (value: string) => value[0].toUpperCase() + value.slice(1);
const extension = (filename: string): string => {
  const match = /\.[^.]+$/.exec(filename);
  return match?.[0].toLowerCase() ?? '';
};
const fileCategory = (value: string): string => {
  const ext = value.replace(/^\./, '');
  if (['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp', 'heif', 'tif', 'tiff', 'bmp', 'ico'].includes(ext)) return 'IMAGE';
  if (['mp4', 'avi', 'mov', 'wmv', 'mpg', 'mpeg'].includes(ext)) return 'VIDEO';
  if (['mp3', 'wav', 'ogg', 'wma'].includes(ext)) return 'AUDIO';
  if (['zip', 'tar', 'iso', 'gz', 'rar', '7z'].includes(ext)) return 'ARCHIVE';
  if (['xls', 'xlsb', 'xlsm', 'xlsx', 'xltx', 'csv', 'tsv', 'ods', 'numbers'].includes(ext)) return 'SPREADSHEET';
  if (['ppt', 'pptx', 'potx', 'odp', 'html', 'key', 'kth'].includes(ext)) return 'PRESENTATION';
  if (['doc', 'docm', 'docx', 'dot', 'dotx', 'odt', 'pdf', 'txt', 'rtf', 'ps', 'tex', 'pages'].includes(ext)) return 'TEXT_DOCUMENT';
  return 'OTHER';
};
const targetField = (row: Row): Record<string, string> => ({ [`target${cap(row.target_type)}Id`]: row.target_id });
const attachment = (row: Row): Row => {
  const ext = extension(String(row.filename));
  return {
    __typename: 'Attachment', id: row.id, name: row.name,
    fullPath: `/api/crm/files/${row.file_id}`, fileCategory: fileCategory(ext),
    file: [{ fileId: row.file_id, label: row.name, extension: ext, url: `/api/crm/files/${row.file_id}`, fileCategory: fileCategory(ext), isDeleted: false }],
    ...targetField(row),
    createdBy: { source: 'MANUAL', workspaceMemberId: row.created_by, name: row.created_by },
    createdAt: row.created_at, updatedAt: row.updated_at, deletedAt: row.deleted_at,
  };
};
const selection = `SELECT a.*, f.filename FROM crm_attachments a JOIN crm_files f ON f.id=a.file_id AND f.workspace_id=a.workspace_id`;

export async function crmAttachments(operation: string, query: string, variables: Vars, env: Env, workspaceId: string, role: string, actor: string): Promise<Response | null> {
  const action = operation.match(/^(FindMany|FindOne|CreateOne|UpdateOne|DeleteOne|RestoreOne|DestroyOne)Attachments?$/i)?.[1];
  if (!action) return null;
  const permissions = await crmPermissions(env, workspaceId, role, 'attachment');
  const required = action.startsWith('Find') ? 'read' : action.startsWith('Create') ? 'create' : action.startsWith('Update') || action.startsWith('Restore') ? 'update' : 'delete';
  if (!permissions[required]) return Response.json({ errors: [{ message: `${cap(required)} access denied`, extensions: { code: 'FORBIDDEN' } }] }, { status: 403 });
  const root = rootField(query) ?? ({ FindMany: 'attachments', FindOne: 'attachment', CreateOne: 'createOneAttachment', UpdateOne: 'updateOneAttachment', DeleteOne: 'deleteOneAttachment', RestoreOne: 'restoreOneAttachment', DestroyOne: 'destroyOneAttachment' } as Record<string, string>)[action];
  const success = (value: unknown) => Response.json({ data: { [root]: value } });
  const id = variables.objectRecordId ?? variables.idToFind ?? variables.idToUpdate ?? variables.idToDelete ?? variables.idToRestore ?? variables.idToDestroy ?? variables.id;
  try {
    if (action === 'FindMany') {
      const filter = object(variables.filter) ? variables.filter : {};
      const targets = Object.entries(targetFields).filter(([field]) => object(filter[field]) && typeof (filter[field] as Record<string, unknown>).eq === 'string');
      if (targets.length !== 1) return Response.json({ errors: [{ message: 'An attachment target filter is required' }] }, { status: 400 });
      const [field, [targetType]] = targets[0]; const targetId = String((filter[field] as Record<string, unknown>).eq);
      const rows = await env.CRM_DB!.prepare(`${selection} WHERE a.workspace_id=? AND a.target_type=? AND a.target_id=? AND a.deleted_at IS NULL ORDER BY a.created_at DESC LIMIT 100`).bind(workspaceId, targetType, targetId).all<Row>();
      const nodes = rows.results.map(attachment);
      return success({ __typename: 'AttachmentConnection', nodes, edges: nodes.map((node, index) => ({ node, cursor: btoa(String(index)) })), totalCount: nodes.length, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: nodes.length ? btoa('0') : null, endCursor: nodes.length ? btoa(String(nodes.length - 1)) : null } });
    }
    if (action === 'FindOne') {
      if (typeof id !== 'string') return Response.json({ errors: [{ message: 'Attachment ID is required' }] }, { status: 400 });
      const row = await env.CRM_DB!.prepare(`${selection} WHERE a.workspace_id=? AND a.id=? AND a.deleted_at IS NULL`).bind(workspaceId, id).first<Row>();
      return success(row ? attachment(row) : null);
    }
    if (action === 'CreateOne') {
      const input = inputFor(variables); const name = typeof input.name === 'string' ? input.name.trim() : '';
      const files = Array.isArray(input.file) ? input.file : [];
      const fileId = object(files[0]) && typeof files[0].fileId === 'string' ? files[0].fileId : '';
      const targets = Object.entries(targetFields).filter(([field]) => typeof input[field] === 'string' && input[field]);
      if (!name || name.length > 255 || files.length !== 1 || !fileId || targets.length !== 1) return Response.json({ errors: [{ message: 'A name, one committed file, and one target are required' }] }, { status: 400 });
      const [targetFieldName, [targetType, table]] = targets[0]; const targetId = String(input[targetFieldName]);
      const file = await env.CRM_DB!.prepare('SELECT filename FROM crm_files WHERE workspace_id=? AND id=?').bind(workspaceId, fileId).first<{filename:string}>();
      const target = await env.CRM_DB!.prepare(`SELECT id FROM ${table} WHERE workspace_id=? AND id=? AND deleted_at IS NULL`).bind(workspaceId, targetId).first();
      if (!file || !target) return Response.json({ errors: [{ message: 'The file or attachment target is not available in this workspace' }] }, { status: 400 });
      if ((targetType === 'task' || targetType === 'note')) {
        const typed = await env.CRM_DB!.prepare('SELECT id FROM activities WHERE workspace_id=? AND id=? AND type=? AND deleted_at IS NULL').bind(workspaceId, targetId, targetType).first();
        if (!typed) return Response.json({ errors: [{ message: `The target is not a ${targetType}` }] }, { status: 400 });
      }
      const attachmentId = crypto.randomUUID(); const now = new Date().toISOString();
      await env.CRM_DB!.batch([
        env.CRM_DB!.prepare('INSERT INTO crm_attachments (id,workspace_id,file_id,name,target_type,target_id,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').bind(attachmentId, workspaceId, fileId, name, targetType, targetId, actor, now, now),
        env.CRM_DB!.prepare('INSERT OR IGNORE INTO crm_file_links (file_id,workspace_id,record_type,record_id,created_at) VALUES (?,?,?,?,?)').bind(fileId, workspaceId, targetType === 'person' ? 'contact' : targetType === 'task' || targetType === 'note' ? 'activity' : targetType, targetId, now),
      ]);
      const row = await env.CRM_DB!.prepare(`${selection} WHERE a.workspace_id=? AND a.id=?`).bind(workspaceId, attachmentId).first<Row>();
      return success(attachment(row!));
    }
    if (typeof id !== 'string' || !id) return Response.json({ errors: [{ message: 'Attachment ID is required' }] }, { status: 400 });
    const existing = await env.CRM_DB!.prepare(`${selection} WHERE a.workspace_id=? AND a.id=?`).bind(workspaceId, id).first<Row>();
    if (!existing) return Response.json({ errors: [{ message: 'Attachment not found' }] }, { status: 404 });
    const now = new Date().toISOString();
    if (action === 'UpdateOne') {
      const input = inputFor(variables); const name = input.name === undefined ? existing.name : typeof input.name === 'string' ? input.name.trim() : '';
      const fileInput = Array.isArray(input.file) && object(input.file[0]) ? input.file[0] : null;
      if (!name || name.length > 255 || fileInput && fileInput.fileId !== existing.file_id) return Response.json({ errors: [{ message: 'Invalid attachment update' }] }, { status: 400 });
      await env.CRM_DB!.prepare('UPDATE crm_attachments SET name=?,updated_at=? WHERE workspace_id=? AND id=? AND deleted_at IS NULL').bind(name, now, workspaceId, id).run();
    } else if (action === 'DeleteOne') {
      if (existing.deleted_at) return Response.json({ errors: [{ message: 'Attachment is already deleted' }] }, { status: 409 });
      await env.CRM_DB!.prepare('UPDATE crm_attachments SET deleted_at=?,updated_at=? WHERE workspace_id=? AND id=? AND deleted_at IS NULL').bind(now, now, workspaceId, id).run();
    } else if (action === 'RestoreOne') {
      if (!existing.deleted_at) return Response.json({ errors: [{ message: 'Attachment is not deleted' }] }, { status: 409 });
      await env.CRM_DB!.prepare('UPDATE crm_attachments SET deleted_at=NULL,updated_at=? WHERE workspace_id=? AND id=? AND deleted_at IS NOT NULL').bind(now, workspaceId, id).run();
    } else {
      if (!existing.deleted_at) return Response.json({ errors: [{ message: 'Move the attachment to trash before destroying it' }] }, { status: 400 });
      await env.CRM_DB!.prepare('DELETE FROM crm_attachments WHERE workspace_id=? AND id=? AND deleted_at IS NOT NULL').bind(workspaceId, id).run();
      return success(attachment(existing));
    }
    const changed = await env.CRM_DB!.prepare(`${selection} WHERE a.workspace_id=? AND a.id=?`).bind(workspaceId, id).first<Row>();
    return success(attachment(changed!));
  } catch (error) {
    console.error('Attachment operation failed', { operation, error: String(error) });
    return Response.json({ errors: [{ message: 'The attachment operation could not be committed', extensions: { code: 'RECORD_CONFLICT' } }] }, { status: 409 });
  }
}
