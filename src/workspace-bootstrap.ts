import type { Env } from './types';
import { compatibilityId } from './compatibility-id';
import { buildCrmView, crmCommands, crmMetadata, crmNavigation, crmViews, parseMetadataJson as parse, type MetadataRow as Row } from './crm-metadata';

type Actor = { subject: string; role: string };
const connection = (nodes: Row[]) => ({ edges: nodes.map(node => ({ node })), pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } });
const fail = (message: string, status = 400) => Response.json({ errors: [{ message }] }, { status });
const result = (key: string, value: unknown) => Response.json({ data: { [key]: value } });
const lowerFirst = (op: string) => op[0].toLowerCase() + op.slice(1);
const viewReads = ['FindAllViews', 'FindManyViews', 'FindFieldsWidgetViews', 'FindTableWidgetViews'];
const viewWrites = ['CreateView', 'UpdateView', 'DestroyView', 'CreateManyViewFields', 'UpdateViewField', 'DestroyViewField', 'CreateViewFilter', 'UpdateViewFilter', 'DestroyViewFilter', 'CreateViewSort', 'UpdateViewSort', 'DestroyViewSort', 'CreateViewFilterGroup', 'UpdateViewFilterGroup', 'DestroyViewFilterGroup', 'CreateManyViewGroups', 'UpdateManyViewGroups'];
const navigationWrites = ['CreateManyNavigationMenuItems', 'UpdateManyNavigationMenuItems', 'DeleteManyNavigationMenuItems'];
const fieldWrites = ['CreateOneFieldMetadataItem', 'UpdateOneFieldMetadataItem', 'DeleteOneFieldMetadataItem'];
const objectWrites = ['CreateOneObjectMetadataItem', 'UpdateOneObjectMetadataItem', 'DeleteOneObjectMetadataItem'];
const operations = new Set(['FindMinimalMetadata', 'ObjectMetadataItems', 'MetadataTranslations', 'FindManyNavigationMenuItems', 'FindManyCommandMenuItems', 'FindAllRecordPageLayouts', 'FindAllRecordFormPageLayouts', 'FindManyLogicFunctions', ...viewReads, ...viewWrites, ...navigationWrites, ...fieldWrites, ...objectWrites]);
const viewSettingsKeys = ['name', 'icon', 'type', 'position', 'isCompact', 'kanbanAggregateOperation', 'kanbanAggregateOperationFieldMetadataId', 'mainGroupByFieldMetadataId', 'shouldHideEmptyGroups', 'kanbanColumnWidth', 'anyFieldFilterValue', 'calendarFieldMetadataId', 'calendarEndFieldMetadataId', 'calendarLayout', 'visibility'];
const pick = (value: Row, keys: string[]) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
const validId = (id: unknown) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

async function persistView(env: Env, workspaceId: string, actor: Actor, view: Row, object: Row): Promise<void> {
  const now = new Date().toISOString();
  view.updatedAt = now;
  // The existing table owns the view identity and filters; this tenant-scoped
  // settings document holds presentation and child collections not in its schema.
  await env.CRM_DB!.batch([
    env.CRM_DB!.prepare('INSERT INTO saved_views (id,workspace_id,object_type,name,filters_json,sort_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,filters_json=excluded.filters_json,sort_json=excluded.sort_json,updated_at=excluded.updated_at WHERE saved_views.workspace_id=excluded.workspace_id')
      .bind(view.id, workspaceId, object.nameSingular === 'person' ? 'contact' : object.nameSingular, view.name, JSON.stringify(view.viewFilters), JSON.stringify(view.viewSorts), view.createdAt, now),
    env.CRM_DB!.prepare('INSERT INTO workspace_settings (workspace_id,setting_key,value_json,updated_at,updated_by) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id,setting_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by')
      .bind(workspaceId, `crm.view:${view.id}`, JSON.stringify(view), now, actor.subject),
  ]);
}

/** Called only after an active workspace membership has been checked. Public
 * callers must not call this helper directly or infer authorization from IDs. */
export async function workspaceBootstrap(op: string, env: Env, workspaceId: string, vars: Row = {}, actor?: Actor): Promise<Response | null> {
  if (!operations.has(op)) return null;
  const db = env.CRM_DB!;
  if (op === 'FindManyCommandMenuItems') return result('commandMenuItems', await crmCommands(workspaceId));
  if (op === 'FindManyLogicFunctions') {
    const rows = await db.prepare("SELECT * FROM native_automation_resources WHERE workspace_id = ? AND kind = 'logic_function' AND status != 'deleted' ORDER BY updated_at DESC LIMIT 200").bind(workspaceId).all<Row>();
    return result('findManyLogicFunctions', rows.results.map(row => ({ __typename: 'LogicFunction', ...parse(row.config_json, {}), id: row.id, name: row.name, description: row.description, createdAt: row.created_at, updatedAt: row.updated_at })));
  }
  if (op === 'FindAllRecordPageLayouts' || op === 'FindAllRecordFormPageLayouts') {
    const stored = await db.prepare("SELECT value_json as value FROM workspace_settings WHERE workspace_id = ? AND setting_key = 'pageLayouts'").bind(workspaceId).first<{ value: string }>();
    const layouts = Object.values(parse(stored?.value, {})) as Row[];
    const type = op === 'FindAllRecordPageLayouts' ? 'RECORD_PAGE' : 'RECORD_FORM';
    return result('getPageLayouts', layouts.filter(layout => layout.type === type).map(layout => ({ __typename: 'PageLayout', ...layout })));
  }
  const objects = await crmMetadata(env, workspaceId);
  if (op === 'ObjectMetadataItems') return result('objects', connection(objects));
  if (op === 'MetadataTranslations') {
    const input = vars.input ?? vars;
    const object = objects.find(item => item.id === input.objectMetadataId);
    if (!object) return fail('Object metadata not found', 404);
    const stored = await db.prepare('SELECT value_json as value FROM workspace_settings WHERE workspace_id = ? AND setting_key = ?')
      .bind(workspaceId, `crm.object-metadata:${object.id}`).first<{ value: string }>();
    const translations = parse(stored?.value, {}).translations;
    const locale = typeof input.locale === 'string' ? input.locale : null;
    const rows = Array.isArray(translations) ? translations.filter((translation: Row) => !locale || translation.locale === locale).map((translation: Row) => ({
      __typename: 'MetadataTranslation', metadataName: 'objectMetadata', recordId: object.id, objectMetadataId: object.id,
      property: translation.property, locale: translation.locale, sourceValue: object[translation.property] ?? null,
      canonicalValue: object[translation.property] ?? null, value: translation.value ?? null, provenance: 'MANUAL',
    })) : [];
    return result('metadataTranslations', rows);
  }
  if (objectWrites.includes(op)) return writeObject(op, env, workspaceId, vars, actor, objects);
  if (fieldWrites.includes(op)) return writeField(op, env, workspaceId, vars, actor, objects);
  const views = await crmViews(env, workspaceId, objects);
  if (op === 'FindMinimalMetadata') return result('minimalMetadata', { objectMetadataItems: objects, views, collectionHashes: [] });
  if (viewReads.includes(op)) {
    const types = vars.viewTypes ?? (op === 'FindFieldsWidgetViews' ? ['FIELDS_WIDGET'] : op === 'FindTableWidgetViews' ? ['TABLE_WIDGET'] : null);
    return result('getViews', views.filter(view => (!vars.objectMetadataId || view.objectMetadataId === vars.objectMetadataId) && (!Array.isArray(types) || types.includes(view.type))));
  }
  if (viewWrites.includes(op)) {
    if (!actor) return fail('Authenticated workspace member required', 403);
    return writeView(op, env, workspaceId, vars, actor, objects, views);
  }
  const items = await crmNavigation(env, workspaceId, objects);
  if (op === 'FindManyNavigationMenuItems') {
    const userWorkspaceId = actor ? await compatibilityId(`member:${workspaceId}:${actor.subject}`) : null;
    return result('navigationMenuItems', items.filter(item => item.userWorkspaceId == null || item.userWorkspaceId === userWorkspaceId));
  }
  if (!actor) return fail('Authenticated workspace member required', 403);
  return writeNavigation(op, env, workspaceId, vars, actor, objects, views, items);
}

async function writeObject(op: string, env: Env, workspaceId: string, vars: Row, actor: Actor | undefined, objects: Row[]): Promise<Response> {
  if (!actor || !['owner', 'admin'].includes(actor.role)) return fail('Workspace administrator required', 403);
  const input = vars.input ?? {};
  if (op === 'CreateOneObjectMetadataItem') {
    const objectInput = input.object ?? input;
    const nameSingular = String(objectInput.nameSingular ?? '').trim();
    const namePlural = String(objectInput.namePlural ?? `${nameSingular}s`).trim();
    if (!/^[a-z][A-Za-z0-9]{1,63}$/.test(nameSingular) || !/^[a-z][A-Za-z0-9]{1,63}$/.test(namePlural)) return fail('Object names must be lower camel case');
    if (objects.some(object => object.nameSingular === nameSingular || object.namePlural === namePlural)) return fail('Object name already exists', 409);
    const labelSingular = String(objectInput.labelSingular ?? nameSingular).trim().slice(0, 120);
    const labelPlural = String(objectInput.labelPlural ?? namePlural).trim().slice(0, 120);
    if (!labelSingular || !labelPlural) return fail('Object labels are required');
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const override = pick(objectInput, ['description', 'icon', 'color', 'isActive', 'isSearchable', 'openRecordIn', 'isLabelSyncedWithName', 'translations']);
    const statements = [env.CRM_DB!.prepare('INSERT INTO custom_objects (id,workspace_id,object_key,label,plural_label,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
      .bind(id, workspaceId, nameSingular, labelSingular, labelPlural, now, now)];
    if (Object.keys(override).length) statements.push(env.CRM_DB!.prepare('INSERT INTO workspace_settings (workspace_id,setting_key,value_json,updated_at,updated_by) VALUES (?,?,?,?,?)')
      .bind(workspaceId, `crm.object-metadata:${id}`, JSON.stringify(override), now, actor.subject));
    await env.CRM_DB!.batch(statements);
    const created = (await crmMetadata(env, workspaceId)).find(object => object.id === id);
    if (!created) return fail('Object creation was not committed', 500);
    return result('createOneObject', created);
  }
  const id = String(vars.idToUpdate ?? vars.idToDelete ?? input.id ?? '');
  const object = objects.find(item => item.id === id);
  if (!object) return fail('Object metadata not found', 404);
  if (op === 'DeleteOneObjectMetadataItem') {
    if (!object.isCustom) return fail('Standard objects cannot be deleted');
    const deleted = await env.CRM_DB!.prepare('DELETE FROM custom_objects WHERE workspace_id = ? AND id = ?').bind(workspaceId, id).run();
    if (Number(deleted.meta?.changes ?? 0) !== 1) return fail('Object metadata not found', 404);
    await env.CRM_DB!.prepare('DELETE FROM workspace_settings WHERE workspace_id = ? AND setting_key = ?').bind(workspaceId, `crm.object-metadata:${id}`).run();
    return result('deleteOneObject', object);
  }
  if (!object.isUIEditable) return fail('Object metadata is read-only', 403);
  const update = vars.updatePayload ?? input.update ?? {};
  const allowed = ['labelSingular', 'labelPlural', 'description', 'icon', 'color', 'isActive', 'isSearchable', 'openRecordIn', 'isLabelSyncedWithName', 'translations'];
  if (Object.keys(update).some(key => !allowed.includes(key))) return fail('Unsupported object metadata update');
  for (const key of ['labelSingular', 'labelPlural']) if (update[key] !== undefined && (typeof update[key] !== 'string' || !update[key].trim() || update[key].length > 120)) return fail('Object labels must contain 1–120 characters');
  if (update.openRecordIn !== undefined && !['SIDE_PANEL', 'RECORD_PAGE', 'USER_CHOICE'].includes(update.openRecordIn)) return fail('Unsupported record opening mode');
  if (update.translations !== undefined && (!Array.isArray(update.translations) || update.translations.some((translation: Row) => typeof translation.locale !== 'string' || typeof translation.property !== 'string' || translation.value !== null && typeof translation.value !== 'string'))) return fail('Invalid metadata translations');
  const settingKey = `crm.object-metadata:${id}`;
  const stored = await env.CRM_DB!.prepare('SELECT value_json as value FROM workspace_settings WHERE workspace_id = ? AND setting_key = ?').bind(workspaceId, settingKey).first<{ value: string }>();
  const previous = parse(stored?.value, {});
  const translations = update.translations === undefined ? previous.translations : [
    ...(Array.isArray(previous.translations) ? previous.translations : []).filter((old: Row) => !update.translations.some((next: Row) => next.locale === old.locale && next.property === old.property)),
    ...update.translations,
  ];
  const next = { ...previous, ...pick(update, allowed.filter(key => key !== 'translations')), ...(translations === undefined ? {} : { translations }) };
  const now = new Date().toISOString();
  const statements = [env.CRM_DB!.prepare('INSERT INTO workspace_settings (workspace_id,setting_key,value_json,updated_at,updated_by) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id,setting_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by')
    .bind(workspaceId, settingKey, JSON.stringify(next), now, actor.subject)];
  if (object.isCustom && (update.labelSingular !== undefined || update.labelPlural !== undefined)) statements.push(env.CRM_DB!.prepare('UPDATE custom_objects SET label=COALESCE(?,label),plural_label=COALESCE(?,plural_label),updated_at=? WHERE workspace_id=? AND id=?')
    .bind(update.labelSingular ?? null, update.labelPlural ?? null, now, workspaceId, id));
  const committed = await env.CRM_DB!.batch(statements);
  if (object.isCustom && statements.length > 1 && Number(committed[1]?.meta?.changes ?? 0) !== 1) return fail('Object metadata update was not committed', 409);
  const updated = (await crmMetadata(env, workspaceId)).find(item => item.id === id);
  if (!updated) return fail('Object metadata update was not committed', 409);
  return result('updateOneObject', updated);
}

async function writeView(op: string, env: Env, workspaceId: string, vars: Row, actor: Actor, objects: Row[], views: Row[]): Promise<Response> {
  const input = vars.input ?? {};
  if (op === 'CreateView' || op === 'UpdateView' || op === 'DestroyView') {
    let view = views.find(view => view.id === (vars.id ?? input.id));
    if (op === 'DestroyView') {
      if (!view) return fail('View not found', 404);
      if (view.key === 'INDEX') return fail('The default view cannot be deleted');
      await env.CRM_DB!.batch([
        env.CRM_DB!.prepare('DELETE FROM saved_views WHERE workspace_id = ? AND id = ?').bind(workspaceId, view.id),
        env.CRM_DB!.prepare('DELETE FROM workspace_settings WHERE workspace_id = ? AND setting_key = ?').bind(workspaceId, `crm.view:${view.id}`),
        env.CRM_DB!.prepare('DELETE FROM workspace_settings WHERE workspace_id = ? AND setting_key LIKE ?').bind(workspaceId, `crm.view-item:${view.id}:%`),
      ]);
      return result('destroyView', view.id);
    }
    if (input.type && !['TABLE', 'KANBAN', 'CALENDAR', 'FIELDS_WIDGET', 'TABLE_WIDGET'].includes(input.type)) return fail('Unsupported view type');
    if (input.visibility && !['WORKSPACE', 'UNLISTED'].includes(input.visibility)) return fail('Unsupported view visibility');
    if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120)) return fail('View name must contain 1–120 characters');
    if (op === 'CreateView') {
      const object = objects.find(object => object.id === input.objectMetadataId);
      if (!object || object.isSystem) return fail('Editable object not found in workspace', 404);
      if (input.id && !validId(input.id)) return fail('Invalid view ID');
      const id = input.id ?? crypto.randomUUID();
      if (views.some(view => view.id === id) || await env.CRM_DB!.prepare('SELECT id FROM saved_views WHERE id = ?').bind(id).first()) return fail('View ID already exists', 409);
      view = await buildCrmView(workspaceId, object, id, input.name ?? `New ${object.labelPlural}`, new Date().toISOString(), null);
      // Twenty creates the new view's copied fields in a separate mutation.
      view.viewFields = [];
    }
    if (!view) return fail('View not found', 404);
    const object = objects.find(object => object.id === view!.objectMetadataId)!;
    const fieldIds = new Set(object.fieldsList.map((field: Row) => field.id));
    for (const key of ['mainGroupByFieldMetadataId', 'kanbanAggregateOperationFieldMetadataId', 'calendarFieldMetadataId', 'calendarEndFieldMetadataId']) {
      if (input[key] && !fieldIds.has(input[key])) return fail('Field does not belong to this view');
    }
    Object.assign(view, pick(input, viewSettingsKeys));
    await persistView(env, workspaceId, actor, view, object);
    return result(lowerFirst(op), view);
  }
  const collection = op.includes('FilterGroup') ? 'viewFilterGroups' : op.includes('Filter') ? 'viewFilters' : op.includes('Sort') ? 'viewSorts' : op.includes('Groups') ? 'viewGroups' : 'viewFields';
  const typename = ({ viewFields: 'ViewField', viewFilters: 'ViewFilter', viewSorts: 'ViewSort', viewFilterGroups: 'ViewFilterGroup', viewGroups: 'ViewGroup' } as Row)[collection];
  const inputs: Row[] = Array.isArray(vars.inputs) ? vars.inputs : [input];
  if (inputs.length > 200) return fail('At most 200 view items can be modified');
  const statements: D1PreparedStatement[] = [];
  const output: Row[] = [];
  for (const entry of inputs) {
    const existingId = vars.id ?? entry.id;
    const view = entry.viewId ? views.find(view => view.id === entry.viewId) : views.find(view => view[collection].some((item: Row) => item.id === existingId));
    if (!view) return fail('View or view item not found', 404);
    const object = objects.find(object => object.id === view.objectMetadataId)!;
    const old = view[collection].find((item: Row) => item.id === existingId);
    const creating = op.startsWith('Create');
    const destroying = op.startsWith('Destroy');
    if (!creating && !old) return fail('View item not found', 404);
    if (creating && old) return fail('View item already exists', 409);
    const now = new Date().toISOString();
    const updates = entry.update ?? entry;
    const keys = ['fieldMetadataId', 'isVisible', 'position', 'size', 'aggregateOperation', 'viewFieldGroupId', 'operand', 'value', 'subFieldName', 'viewFilterGroupId', 'positionInViewFilterGroup', 'relationTargetFieldMetadataId', 'direction', 'logicalOperator', 'parentViewFilterGroupId', 'fieldValue'];
    const next: Row = { __typename: typename, id: existingId ?? crypto.randomUUID(), viewId: view.id, workspaceId,
      isActive: true, isVisible: true, position: view[collection].length, size: 180, aggregateOperation: null, viewFieldGroupId: null,
      operand: 'IS', value: '', subFieldName: null, viewFilterGroupId: null, positionInViewFilterGroup: null, relationTargetFieldMetadataId: null,
      direction: 'ASC', logicalOperator: 'AND', parentViewFilterGroupId: null, createdAt: now, deletedAt: null,
      ...old, ...pick(updates, keys), updatedAt: now };
    if (!validId(next.id)) return fail('Invalid view item ID');
    if (['viewFields', 'viewFilters', 'viewSorts'].includes(collection) && !object.fieldsList.some((field: Row) => field.id === next.fieldMetadataId)) return fail('Field does not belong to this view');
    if (next.viewFilterGroupId && !view.viewFilterGroups.some((group: Row) => group.id === next.viewFilterGroupId)) return fail('Filter group does not belong to this view');
    if (collection === 'viewSorts' && !['ASC', 'DESC'].includes(next.direction)) return fail('Invalid sort direction');
    if (collection === 'viewFilterGroups' && !['AND', 'OR', 'NOT'].includes(next.logicalOperator)) return fail('Invalid logical operator');
    view[collection] = view[collection].filter((item: Row) => item.id !== next.id);
    if (!destroying) view[collection].push(next);
    // Separate per-item keys preserve parallel filter/sort mutations from
    // Twenty's client. Replacing the complete view would lose concurrent edits.
    statements.push(env.CRM_DB!.prepare('INSERT INTO workspace_settings (workspace_id,setting_key,value_json,updated_at,updated_by) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id,setting_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by')
      .bind(workspaceId, `crm.view-item:${view.id}:${collection}:${next.id}`, JSON.stringify(destroying ? null : next), now, actor.subject));
    output.push(destroying ? old : next);
  }
  if (statements.length) await env.CRM_DB!.batch(statements);
  const scalar = op === 'DestroyViewSort' || op === 'DestroyViewFilterGroup';
  return result(lowerFirst(op), op.includes('Many') ? output : scalar ? output[0].id : output[0]);
}

async function writeNavigation(op: string, env: Env, workspaceId: string, vars: Row, actor: Actor, objects: Row[], views: Row[], items: Row[]): Promise<Response> {
  const userWorkspaceId = await compatibilityId(`member:${workspaceId}:${actor.subject}`);
  const canEdit = (item: Row) => item.userWorkspaceId === userWorkspaceId || item.userWorkspaceId == null && ['owner', 'admin'].includes(actor.role);
  const changed: Row[] = [];
  if (op === 'DeleteManyNavigationMenuItems') {
    if (!Array.isArray(vars.ids) || vars.ids.length > 200) return fail('Navigation IDs required (maximum 200)');
    for (const id of vars.ids) {
      const item = items.find(item => item.id === id);
      if (!item) return fail('Navigation item not found', 404);
      if (!canEdit(item)) return fail('Cannot edit this navigation item', 403);
      changed.push(item);
    }
    items = items.filter(item => !vars.ids.includes(item.id));
  } else {
    if (!Array.isArray(vars.inputs) || vars.inputs.length > 200) return fail('Navigation inputs required (maximum 200)');
    for (const input of vars.inputs) {
      const old = items.find(item => item.id === input.id);
      if (op.startsWith('Update') && !old) return fail('Navigation item not found', 404);
      if (op.startsWith('Create') && old) return fail('Navigation item already exists', 409);
      const data = input.update ?? input;
      const now = new Date().toISOString();
      const next: Row = { __typename: 'NavigationMenuItem', id: input.id ?? crypto.randomUUID(), type: 'OBJECT', userWorkspaceId: null,
        targetRecordId: null, targetObjectMetadataId: null, viewId: null, folderId: null, name: null, link: null, icon: null, color: null,
        pageLayoutId: null, position: items.length, applicationId: null, targetRecordIdentifier: null, createdAt: now, ...old,
        ...pick(data, ['type', 'userWorkspaceId', 'targetRecordId', 'targetObjectMetadataId', 'viewId', 'folderId', 'name', 'link', 'icon', 'color', 'pageLayoutId', 'position']), updatedAt: now };
      if (!validId(next.id)) return fail('Invalid navigation ID');
      if (old && !canEdit(old) || !canEdit(next)) return fail('Cannot edit this navigation item', 403);
      if (!['OBJECT', 'VIEW', 'FOLDER', 'LINK'].includes(next.type)) return fail('This navigation target is not supported yet');
      if (next.type === 'OBJECT' && !objects.some(object => object.id === next.targetObjectMetadataId)) return fail('Object not found in workspace', 404);
      if (next.type === 'VIEW' && !views.some(view => view.id === next.viewId)) return fail('View not found in workspace', 404);
      if (next.type === 'LINK') { try { if (!['https:', 'http:'].includes(new URL(next.link).protocol)) return fail('Only HTTP(S) navigation links are allowed'); } catch { return fail('Invalid navigation link'); } }
      if (next.folderId && !items.some(folder => folder.id === next.folderId && folder.type === 'FOLDER' && folder.userWorkspaceId === next.userWorkspaceId)) return fail('Folder not found');
      items = [...items.filter(item => item.id !== next.id), next];
      changed.push(next);
    }
  }
  // Per-item writes preserve additions from different members delivered at the
  // same time; a whole navigation-array replacement would lose acknowledged edits.
  if (changed.length) await env.CRM_DB!.batch(changed.map(item => env.CRM_DB!.prepare('INSERT INTO workspace_settings (workspace_id,setting_key,value_json,updated_at,updated_by) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id,setting_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by')
    .bind(workspaceId, `crm.navigation-item:${item.id}`, JSON.stringify(op.startsWith('Delete') ? null : item), new Date().toISOString(), actor.subject)));
  return result(lowerFirst(op), changed);
}

async function writeField(op: string, env: Env, workspaceId: string, vars: Row, actor: Actor | undefined, objects: Row[]): Promise<Response> {
  if (!actor || !['owner', 'admin'].includes(actor.role)) return fail('Workspace administrator required', 403);
  const input = vars.input ?? {};
  const id = vars.idToUpdate ?? vars.idToDelete ?? input.id;
  const old = id ? objects.flatMap(object => object.fieldsList.map((field: Row) => ({ ...field, object: { __typename: 'Object', id: object.id } }))).find(field => field.id === id) : null;
  if (op !== 'CreateOneFieldMetadataItem') {
    const persisted = await env.CRM_DB!.prepare('SELECT id, field_type FROM custom_fields WHERE workspace_id = ? AND id = ?').bind(workspaceId, id ?? '').first<{ id: string; field_type: string }>();
    if (!old || !persisted) return fail('Editable custom field not found', 404);
    if (op === 'DeleteOneFieldMetadataItem') {
      await env.CRM_DB!.prepare('DELETE FROM custom_fields WHERE workspace_id = ? AND id = ?').bind(workspaceId, id).run();
      return result('deleteOneField', old);
    }
    const update = vars.updatePayload ?? input.update ?? {};
    if (Object.keys(update).some(key => !['label', 'options'].includes(key))) return fail('Only custom field labels and options can currently be changed');
    if (update.label !== undefined && (typeof update.label !== 'string' || !update.label.trim() || update.label.length > 120)) return fail('Invalid field label');
    if (update.options !== undefined && !validOptions(update.options)) return fail('Invalid select options');
    await env.CRM_DB!.prepare('UPDATE custom_fields SET label = COALESCE(?,label), options_json = COALESCE(?,options_json) WHERE workspace_id = ? AND id = ?')
      .bind(update.label ?? null, update.options !== undefined ? JSON.stringify(update.options) : null, workspaceId, id).run();
    return result('updateOneField', { ...old, ...update });
  }
  const field = input.field ?? input;
  const object = objects.find(object => object.id === field.objectMetadataId);
  if (!object || object.isSystem) return fail('Editable object not found in workspace', 404);
  const type = ({ TEXT: 'text', NUMBER: 'number', BOOLEAN: 'boolean', DATE: 'date', DATE_TIME: 'date_time', SELECT: 'select', MULTI_SELECT: 'multi_select', CURRENCY: 'currency', ADDRESS: 'address', RICH_TEXT_V2: 'rich_text', ACTOR: 'actor', ARRAY: 'array', RELATION: 'relation', UUID: 'uuid' } as Row)[field.type];
  if (!type) return fail('Unsupported custom field type');
  if (field.isUnique || field.isNullable === false) return fail('Custom uniqueness and required constraints are not supported yet');
  if (typeof field.name !== 'string' || !/^[a-z][a-zA-Z0-9_]{0,63}$/.test(field.name) || object.fieldsList.some((existing: Row) => existing.name === field.name)) return fail('Invalid or duplicate field name');
  if (typeof field.label !== 'string' || !field.label.trim() || field.label.length > 120) return fail('Invalid field label');
  if (field.options != null && !validOptions(field.options)) return fail('Invalid select options');
  const fieldId = crypto.randomUUID();
  await env.CRM_DB!.prepare('INSERT INTO custom_fields (id,workspace_id,object_type,field_key,label,field_type,options_json,settings_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
    .bind(fieldId, workspaceId, object.nameSingular === 'person' ? 'contact' : object.nameSingular, field.name, field.label, type, field.options ? JSON.stringify(field.options) : null, field.settings ? JSON.stringify(field.settings) : null, new Date().toISOString()).run();
  const updated = (await crmMetadata(env, workspaceId)).find(item => item.id === object.id)!.fieldsList.find((item: Row) => item.id === fieldId);
  return result('createOneField', { ...updated, object: { __typename: 'Object', id: object.id } });
}

function validOptions(options: unknown): boolean {
  return Array.isArray(options) && options.length <= 200 && options.every(option => typeof option === 'string' && option.length <= 120 || option !== null && typeof option === 'object' && typeof option.value === 'string' && option.value.length <= 120 && typeof option.label === 'string' && option.label.length <= 120);
}
