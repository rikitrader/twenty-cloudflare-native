import type { Env } from './types';
import { compatibilityId } from './compatibility-id';

export type MetadataRow = Record<string, any>;
export const parseMetadataJson = (value: unknown, fallback: any): any => {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; }
  catch { return fallback; }
};
type FieldDefinition = { name: string; type: string; label: string; target?: string; inverse?: string; many?: boolean; options?: string[]; morphTargets?: string[] };
type Definition = { name: string; plural: string; label: string; labels: string; icon: string; fields: FieldDefinition[]; system?: boolean; writableSystem?: boolean };
const text = (name: string, label: string): FieldDefinition => ({ name, label, type: 'TEXT' });
const relation = (name: string, label: string, target: string, inverse: string, many = false): FieldDefinition => ({ name, label, target, inverse, many, type: 'RELATION' });

/** These fields describe persisted native columns, not upstream features that the
 * D1 data model does not implement. Inverse relations are read-only connections. */
export const crmDefinitions: Definition[] = [
  { name: 'person', plural: 'people', label: 'Person', labels: 'People', icon: 'IconUser', fields: [
    { name: 'name', label: 'Name', type: 'FULL_NAME' }, text('email', 'Email'),
    relation('opportunities', 'Opportunities', 'opportunity', 'pointOfContact', true), relation('activities', 'Activities', 'activity', 'contact', true), relation('attachments', 'Attachments', 'attachment', 'targetPerson', true), relation('taskTargets', 'Task targets', 'taskTarget', 'target', true), relation('noteTargets', 'Note targets', 'noteTarget', 'target', true),
  ] },
  { name: 'company', plural: 'companies', label: 'Company', labels: 'Companies', icon: 'IconBuildingSkyscraper', fields: [
    text('name', 'Name'), text('domain', 'Domain'), relation('opportunities', 'Opportunities', 'opportunity', 'company', true), relation('activities', 'Activities', 'activity', 'company', true), relation('attachments', 'Attachments', 'attachment', 'targetCompany', true), relation('taskTargets', 'Task targets', 'taskTarget', 'target', true), relation('noteTargets', 'Note targets', 'noteTarget', 'target', true),
  ] },
  { name: 'opportunity', plural: 'opportunities', label: 'Opportunity', labels: 'Opportunities', icon: 'IconTargetArrow', fields: [
    text('name', 'Name'), { name: 'amount', label: 'Amount', type: 'NUMBER' },
    { name: 'stage', label: 'Stage', type: 'SELECT', options: ['prospecting', 'qualification', 'proposal', 'negotiation', 'won', 'lost'] },
    relation('company', 'Company', 'company', 'opportunities'), relation('pointOfContact', 'Point of contact', 'person', 'opportunities'), relation('activities', 'Activities', 'activity', 'opportunity', true), relation('attachments', 'Attachments', 'attachment', 'targetOpportunity', true), relation('taskTargets', 'Task targets', 'taskTarget', 'target', true), relation('noteTargets', 'Note targets', 'noteTarget', 'target', true),
  ] },
  { name: 'activity', plural: 'activities', label: 'Activity', labels: 'Activities', icon: 'IconTimelineEvent', fields: [
    text('title', 'Title'), text('body', 'Body'), { name: 'type', label: 'Type', type: 'SELECT', options: ['note', 'task', 'call', 'email'] },
    { name: 'dueAt', label: 'Due at', type: 'DATE_TIME' }, { name: 'completedAt', label: 'Completed at', type: 'DATE_TIME' },
    relation('contact', 'Person', 'person', 'activities'), relation('company', 'Company', 'company', 'activities'), relation('opportunity', 'Opportunity', 'opportunity', 'activities'), relation('attachments', 'Attachments', 'attachment', 'targetActivity', true),
  ] },
  { name: 'attachment', plural: 'attachments', label: 'Attachment', labels: 'Attachments', icon: 'IconFileImport', system: true, fields: [
    text('name', 'Name'), { name: 'file', label: 'File', type: 'FILES' },
    relation('targetPerson', 'Person', 'person', 'attachments'), relation('targetCompany', 'Company', 'company', 'attachments'),
    relation('targetOpportunity', 'Opportunity', 'opportunity', 'attachments'), relation('targetActivity', 'Activity', 'activity', 'attachments'),
  ] },
  { name: 'task', plural: 'tasks', label: 'Task', labels: 'Tasks', icon: 'IconCheckbox', system: true, writableSystem: true, fields: [
    text('title', 'Title'), { name: 'bodyV2', label: 'Body', type: 'RICH_TEXT_V2' }, { name: 'dueAt', label: 'Due at', type: 'DATE_TIME' },
    { name: 'status', label: 'Status', type: 'SELECT', options: ['TODO', 'DONE'] }, relation('taskTargets', 'Targets', 'taskTarget', 'task', true),
  ] },
  { name: 'note', plural: 'notes', label: 'Note', labels: 'Notes', icon: 'IconNotes', system: true, writableSystem: true, fields: [
    text('title', 'Title'), { name: 'bodyV2', label: 'Body', type: 'RICH_TEXT_V2' }, relation('noteTargets', 'Targets', 'noteTarget', 'note', true),
  ] },
  { name: 'taskTarget', plural: 'taskTargets', label: 'Task target', labels: 'Task targets', icon: 'IconRelationManyToMany', system: true, writableSystem: true, fields: [
    relation('task', 'Task', 'task', 'taskTargets'), { name: 'target', label: 'Target', type: 'MORPH_RELATION', morphTargets: ['person', 'company', 'opportunity'] },
  ] },
  { name: 'noteTarget', plural: 'noteTargets', label: 'Note target', labels: 'Note targets', icon: 'IconRelationManyToMany', system: true, writableSystem: true, fields: [
    relation('note', 'Note', 'note', 'noteTargets'), { name: 'target', label: 'Target', type: 'MORPH_RELATION', morphTargets: ['person', 'company', 'opportunity'] },
  ] },
  { name: 'workspaceMember', plural: 'workspaceMembers', label: 'Workspace member', labels: 'Workspace members', icon: 'IconUsers', system: true, fields: [
    { name: 'name', label: 'Name', type: 'FULL_NAME' }, { name: 'userId', label: 'User ID', type: 'UUID' },
    { name: 'userWorkspaceId', label: 'Membership ID', type: 'UUID' }, text('userEmail', 'Email'), text('avatarUrl', 'Avatar'),
    text('locale', 'Locale'), text('colorScheme', 'Color scheme'), text('uiScale', 'UI scale'), text('openRecordIn', 'Open record in'),
    text('timeZone', 'Time zone'), text('dateFormat', 'Date format'), text('timeFormat', 'Time format'), text('numberFormat', 'Number format'),
    { name: 'calendarStartDay', label: 'Calendar start day', type: 'NUMBER' },
  ] },
  { name: 'blocklist', plural: 'blocklists', label: 'Blocklist entry', labels: 'Blocklist entries', icon: 'IconMailOff', system: true, writableSystem: true, fields: [
    text('handle', 'Email or domain'), { name: 'scope', label: 'Scope', type: 'SELECT', options: ['WORKSPACE'] },
  ] },
  // Twenty mounts a workflow-version lazy-query hook for every command button,
  // even when the command is ordinary CRM CRUD. This internal read-only view
  // describes the current native_workflows definition, not version history or
  // a claim that the upstream workflow editor/execution engine is implemented.
  { name: 'workflowVersion', plural: 'workflowVersions', label: 'Workflow version', labels: 'Workflow versions', icon: 'IconVersions', system: true, fields: [
    text('name', 'Name'), { name: 'workflowId', label: 'Workflow ID', type: 'UUID' },
    { name: 'status', label: 'Status', type: 'SELECT', options: ['DRAFT', 'ACTIVE', 'DEACTIVATED', 'ARCHIVED'] },
    { name: 'trigger', label: 'Trigger', type: 'RAW_JSON' }, { name: 'steps', label: 'Steps', type: 'RAW_JSON' },
    relation('workflow', 'Workflow', 'workflow', 'versions'),
  ] },
  // The New-record engine component always constructs useCreateCoreWorkflow,
  // including on People/Companies. Metadata is required to construct that hook;
  // SYSTEM writability keeps its unsupported workflow-create branch unavailable.
  { name: 'workflow', plural: 'workflows', label: 'Workflow', labels: 'Workflows', icon: 'IconSettingsAutomation', system: true, fields: [
    text('name', 'Name'), text('description', 'Description'),
    { name: 'statuses', label: 'Statuses', type: 'MULTI_SELECT', options: ['DRAFT', 'ACTIVE', 'DEACTIVATED'] },
    { name: 'lastPublishedVersionId', label: 'Published version ID', type: 'UUID' },
    relation('versions', 'Current native definition', 'workflowVersion', 'workflow', true),
  ] },
];

export const canonicalObjectName = (name: string): string => ({ contact: 'person', contacts: 'person', people: 'person', companies: 'company', opportunities: 'opportunity', activities: 'activity' } as Record<string, string>)[name] ?? name;
export const objectMetadataId = (workspaceId: string, name: string) => compatibilityId(`object:${workspaceId}:${canonicalObjectName(name)}`);
export const defaultViewId = (workspaceId: string, name: string) => compatibilityId(`view:${workspaceId}:${canonicalObjectName(name)}:index`);

export async function crmMetadata(env: Env, workspaceId: string): Promise<MetadataRow[]> {
  const created = await env.CRM_DB!.prepare('SELECT created_at as createdAt FROM workspaces WHERE id = ?').bind(workspaceId).first<{ createdAt: string }>();
  const timestamp = created?.createdAt ?? new Date().toISOString();
  const custom = await env.CRM_DB!.prepare('SELECT * FROM custom_fields WHERE workspace_id = ? ORDER BY created_at, id').bind(workspaceId).all<MetadataRow>();
  const customObjects = await env.CRM_DB!.prepare('SELECT * FROM custom_objects WHERE workspace_id = ? ORDER BY created_at, id').bind(workspaceId).all<MetadataRow>();
  const objectSettings = await env.CRM_DB!.prepare("SELECT setting_key,value_json FROM workspace_settings WHERE workspace_id = ? AND setting_key LIKE 'crm.object-metadata:%'").bind(workspaceId).all<MetadataRow>();
  const objectOverrides = new Map(objectSettings.results.map(row => [row.setting_key.slice('crm.object-metadata:'.length), parseMetadataJson(row.value_json, {})]));
  const dynamicDefinitions: Definition[] = customObjects.results
    .filter(row => typeof row.object_key === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(row.object_key))
    .map(row => ({ name: row.object_key, plural: row.object_key.endsWith('s') ? row.object_key : `${row.object_key}s`, label: row.label, labels: row.plural_label, icon: 'IconBox', fields: [] }));
  const definitions = [...crmDefinitions, ...dynamicDefinitions];
  const customObjectIds = new Map(customObjects.results.map(row => [row.object_key, row.id]));
  const objectIds = Object.fromEntries(await Promise.all(definitions.map(async object => [object.name, customObjectIds.get(object.name) ?? await objectMetadataId(workspaceId, object.name)])));
  const objectRef = (name: string) => { const definition = definitions.find(object => object.name === name)!; return { __typename: 'Object', id: objectIds[name], nameSingular: name, namePlural: definition.plural }; };

  return Promise.all(definitions.map(async object => {
    const id = objectIds[object.name];
    const definitions: FieldDefinition[] = [{ name: 'id', label: 'ID', type: 'UUID' }, ...object.fields,
      { name: 'createdAt', label: 'Created at', type: 'DATE_TIME' }, { name: 'updatedAt', label: 'Updated at', type: 'DATE_TIME' }, { name: 'deletedAt', label: 'Deleted at', type: 'DATE_TIME' }];
    const fieldsList: MetadataRow[] = await Promise.all(definitions.map(async definition => {
      const fieldId = await compatibilityId(`field:${id}:${definition.name}`);
      const system = object.system === true && object.writableSystem !== true || ['id', 'createdAt', 'updatedAt', 'deletedAt'].includes(definition.name);
      const field: MetadataRow = { __typename: 'Field', id: fieldId, universalIdentifier: fieldId, name: definition.name, label: definition.label, type: definition.type,
        description: null, icon: definition.type === 'RELATION' ? 'IconRelationManyToOne' : 'IconText', isActive: true, isSystem: system,
        isUIEditable: !system && !definition.many, writability: system || definition.many ? 'SYSTEM' : 'OPEN', isNullable: definition.name !== 'id',
        isUnique: definition.name === 'id', isSearchable: ['TEXT', 'FULL_NAME'].includes(definition.type), createdAt: timestamp, updatedAt: timestamp,
        defaultValue: null, options: definition.options ? await Promise.all(definition.options.map(async (value, position) => ({ id: await compatibilityId(`option:${fieldId}:${value}`), value, label: value[0].toUpperCase() + value.slice(1), position, color: ['gray', 'blue', 'purple', 'orange', 'green', 'red'][position % 6] }))) : null,
        settings: definition.target ? { relationType: definition.many ? 'ONE_TO_MANY' : 'MANY_TO_ONE', joinColumnName: definition.many ? null : `${definition.name}Id`, ...(['taskTargets', 'noteTargets'].includes(definition.name) ? { junctionTargetFieldId: await compatibilityId(`field:${objectIds[definition.target]}:target`) } : {}) } : definition.type === 'DATE_TIME' ? { displayFormat: 'RELATIVE' } : null,
        isLabelSyncedWithName: false, morphId: null, applicationId: null, relation: null, morphRelations: [],
      };
      if (definition.target) field.relation = { __typename: 'Relation', type: definition.many ? 'ONE_TO_MANY' : 'MANY_TO_ONE',
        sourceObjectMetadata: objectRef(object.name), targetObjectMetadata: objectRef(definition.target),
        sourceFieldMetadata: { __typename: 'Field', id: fieldId, name: definition.name },
        targetFieldMetadata: { __typename: 'Field', id: await compatibilityId(`field:${objectIds[definition.target]}:${definition.inverse}`), name: definition.inverse },
      };
      if (definition.morphTargets?.length) {
        field.morphId = await compatibilityId(`morph:${id}:${definition.name}`);
        field.morphRelations = await Promise.all(definition.morphTargets.map(async target => ({
          __typename: 'Relation', type: 'MANY_TO_ONE',
          sourceObjectMetadata: objectRef(object.name), targetObjectMetadata: objectRef(target),
          sourceFieldMetadata: { __typename: 'Field', id: fieldId, name: definition.name },
          targetFieldMetadata: { __typename: 'Field', id: await compatibilityId(`field:${objectIds[target]}:${object.name === 'taskTarget' ? 'taskTargets' : 'noteTargets'}`), name: object.name === 'taskTarget' ? 'taskTargets' : 'noteTargets' },
        })));
      }
      return field;
    }));
    for (const field of custom.results.filter(field => canonicalObjectName(field.object_type) === object.name || field.object_type === id)) {
      if (fieldsList.some(existing => existing.name === field.field_key)) continue;
      const type = ({ text: 'TEXT', number: 'NUMBER', boolean: 'BOOLEAN', date: 'DATE', date_time: 'DATE_TIME', select: 'SELECT', multi_select: 'MULTI_SELECT', currency: 'CURRENCY', address: 'ADDRESS', rich_text: 'RICH_TEXT_V2', actor: 'ACTOR', array: 'ARRAY', relation: 'RELATION', uuid: 'UUID' } as Record<string, string>)[field.field_type];
      if (!type) continue;
      const rawOptions = parseMetadataJson(field.options_json, []);
      const options = ['SELECT', 'MULTI_SELECT'].includes(type) && Array.isArray(rawOptions) ? await Promise.all(rawOptions.filter(value => typeof value === 'string' || value !== null && typeof value === 'object' && typeof value.value === 'string').slice(0, 200).map(async (value, position) => {
        const item = typeof value === 'string' ? { value, label: value } : value;
        return { ...item, id: item.id ?? await compatibilityId(`option:${field.id}:${item.value}`), position: item.position ?? position, color: item.color ?? 'gray' };
      })) : null;
      fieldsList.push({ ...fieldsList[0], id: field.id, universalIdentifier: field.id, name: field.field_key, label: field.label, type, isSystem: false,
        isUIEditable: true, writability: 'OPEN', isNullable: field.is_nullable !== 0, isUnique: field.is_unique === 1, isSearchable: ['TEXT', 'RICH_TEXT_V2'].includes(type), options,
        settings: parseMetadataJson(field.settings_json, null), createdAt: field.created_at, updatedAt: field.created_at });
    }
    const labelField = fieldsList.find(field => field.name === (object.name === 'activity' ? 'title' : 'name'))
      ?? fieldsList.find(field => !field.isSystem && ['TEXT', 'FULL_NAME'].includes(field.type))
      ?? fieldsList[0];
    const override = objectOverrides.get(id) ?? {};
    const visibleOverride = Object.fromEntries(['labelSingular', 'labelPlural', 'description', 'icon', 'color', 'isActive', 'isSearchable', 'openRecordIn', 'isLabelSyncedWithName'].filter(key => Object.hasOwn(override, key)).map(key => [key, override[key]]));
    return { ...objectRef(object.name), universalIdentifier: id, labelSingular: object.label, labelPlural: object.labels,
      icon: object.icon, color: null, description: null, isRemote: false, isActive: true, isSystem: object.system === true, isUIEditable: !object.system || object.writableSystem === true, isUICreatable: !object.system || object.writableSystem === true,
      isCustom: customObjectIds.has(object.name), writability: object.system && object.writableSystem !== true ? 'SYSTEM' : 'OPEN', createdAt: customObjects.results.find(row => row.id === id)?.created_at ?? timestamp, updatedAt: customObjects.results.find(row => row.id === id)?.updated_at ?? timestamp, labelIdentifierFieldMetadataId: labelField.id,
      imageIdentifierFieldMetadataId: null, applicationId: null, shortcut: null, isLabelSyncedWithName: true, isSearchable: true, openRecordIn: 'SIDE_PANEL',
      duplicateCriteria: [], searchFieldMetadataList: [], indexMetadataList: [], fieldsList, ...visibleOverride };
  }));
}

export async function buildCrmView(workspaceId: string, object: MetadataRow, id: string, name: string, timestamp: string, key: string | null): Promise<MetadataRow> {
  return { __typename: 'View', id, universalIdentifier: id, workspaceId, name, objectMetadataId: object.id, type: 'TABLE', key, icon: object.icon,
    position: 0, isCompact: false, kanbanAggregateOperation: null, kanbanAggregateOperationFieldMetadataId: null, mainGroupByFieldMetadataId: null,
    shouldHideEmptyGroups: false, kanbanColumnWidth: 240, anyFieldFilterValue: '', calendarFieldMetadataId: null, calendarEndFieldMetadataId: null,
    calendarLayout: 'MONTH', visibility: 'WORKSPACE', createdByUserWorkspaceId: null, isActive: true, isCustom: key !== 'INDEX',
    isSystemSideEffect: false, applicationId: null, openRecordIn: 'SIDE_PANEL', createdAt: timestamp, updatedAt: timestamp, deletedAt: null,
    viewFields: await Promise.all(object.fieldsList.filter((field: MetadataRow) => field.name !== 'id' && field.name !== 'deletedAt' && field.relation?.type !== 'ONE_TO_MANY').map(async (field: MetadataRow, position: number) => ({
      __typename: 'ViewField', id: await compatibilityId(`view-field:${id}:${field.id}`), fieldMetadataId: field.id, viewId: id, workspaceId,
      isVisible: !['createdAt', 'updatedAt', 'body'].includes(field.name), position, size: field.name === 'name' || field.name === 'title' ? 240 : 180,
      aggregateOperation: null, viewFieldGroupId: null, isActive: true, createdAt: timestamp, updatedAt: timestamp, deletedAt: null,
    }))), viewFieldGroups: [], viewFilters: [], viewFilterGroups: [], viewSorts: [], viewGroups: [] };
}

export async function crmViews(env: Env, workspaceId: string, objects: MetadataRow[]): Promise<MetadataRow[]> {
  const rows = await env.CRM_DB!.prepare('SELECT * FROM saved_views WHERE workspace_id = ? ORDER BY created_at, id').bind(workspaceId).all<MetadataRow>();
  const settings = await env.CRM_DB!.prepare("SELECT setting_key, value_json FROM workspace_settings WHERE workspace_id = ? AND setting_key LIKE 'crm.view:%'").bind(workspaceId).all<MetadataRow>();
  const configured = new Map(settings.results.map(row => [row.setting_key.slice('crm.view:'.length), parseMetadataJson(row.value_json, {})]));
  const views = await Promise.all(objects.filter(object => !object.isSystem).map(async object => buildCrmView(workspaceId, object, await defaultViewId(workspaceId, object.nameSingular), `All ${object.labelPlural}`, object.createdAt, 'INDEX')));
  for (const row of rows.results) {
    const object = objects.find(object => object.id === row.object_type || object.nameSingular === canonicalObjectName(row.object_type));
    if (!object) continue;
    const existing = views.findIndex(view => view.id === row.id);
    const view = { ...await buildCrmView(workspaceId, object, row.id, row.name, row.created_at, existing >= 0 ? 'INDEX' : null),
      updatedAt: row.updated_at, viewFilters: parseMetadataJson(row.filters_json, []), viewSorts: parseMetadataJson(row.sort_json, []) };
    if (existing >= 0) views[existing] = view; else views.push(view);
  }
  const merged = views.map(view => ({ ...view, ...configured.get(view.id), id: view.id, workspaceId, objectMetadataId: view.objectMetadataId, __typename: 'View' }));
  const children = await env.CRM_DB!.prepare("SELECT setting_key, value_json FROM workspace_settings WHERE workspace_id = ? AND setting_key LIKE 'crm.view-item:%'").bind(workspaceId).all<MetadataRow>();
  for (const row of children.results) {
    const [, viewId, collection, childId] = row.setting_key.split(':');
    const view = merged.find(view => view.id === viewId);
    if (!view || !['viewFields', 'viewFilters', 'viewSorts', 'viewFilterGroups', 'viewGroups'].includes(collection)) continue;
    const item = parseMetadataJson(row.value_json, null);
    view[collection] = view[collection].filter((existing: MetadataRow) => existing.id !== childId);
    if (item !== null && item.id === childId && item.viewId === viewId) view[collection].push(item);
  }
  return merged;
}

export async function crmNavigation(env: Env, workspaceId: string, objects: MetadataRow[]): Promise<MetadataRow[]> {
  const defaults = await Promise.all(objects.filter(object => !object.isSystem).map(async (object, position) => ({ __typename: 'NavigationMenuItem', id: await compatibilityId(`navigation:${workspaceId}:${object.nameSingular}`),
    type: 'OBJECT', userWorkspaceId: null, targetRecordId: null, targetObjectMetadataId: object.id, viewId: null, folderId: null,
    name: object.labelPlural, link: null, icon: object.icon, color: null, pageLayoutId: null, position, applicationId: null,
    createdAt: object.createdAt, updatedAt: object.updatedAt, targetRecordIdentifier: null })));
  const stored = await env.CRM_DB!.prepare("SELECT value_json FROM workspace_settings WHERE workspace_id = ? AND setting_key = 'navigationMenuItems'").bind(workspaceId).first<{ value_json: string }>();
  const legacy = stored ? parseMetadataJson(stored.value_json, []) : null;
  const legacyItems: MetadataRow[] = stored && Array.isArray(legacy)
    ? legacy.filter(item => item !== null && typeof item === 'object').map(item => ({ __typename: 'NavigationMenuItem', ...item }))
    : [];
  // Early Cloudflare builds stored a whole sidebar snapshot. A partial or empty
  // snapshot must not hide standard CRM objects forever. Merge it over the
  // generated baseline; current per-item tombstones below remain authoritative.
  const legacyObjectTargets = new Set(legacyItems.filter(item => item.type === 'OBJECT').map(item => item.targetObjectMetadataId));
  let items: MetadataRow[] = [...legacyItems, ...defaults.filter(item => !legacyObjectTargets.has(item.targetObjectMetadataId))];
  const changes = await env.CRM_DB!.prepare("SELECT setting_key, value_json FROM workspace_settings WHERE workspace_id = ? AND setting_key LIKE 'crm.navigation-item:%'").bind(workspaceId).all<MetadataRow>();
  for (const row of changes.results) {
    const id = row.setting_key.slice('crm.navigation-item:'.length);
    const item = parseMetadataJson(row.value_json, null);
    items = items.filter(existing => existing.id !== id);
    if (item !== null && item.id === id) items.push({ ...item, __typename: 'NavigationMenuItem' });
  }
  return items.sort((a, b) => a.position - b.position);
}

/** Engine-backed actions from Twenty's standard command definitions. They call
 * the existing frontend command components and the authorized CRM API; these
 * are command metadata, never synthetic successful mutation responses. */
export async function crmCommands(workspaceId: string): Promise<MetadataRow[]> {
  const definitions = [
    ['CREATE_NEW_RECORD', 'Create new {objectLabelSingular}', 'New {objectLabelSingular}', 'IconPlus', 'GLOBAL_OBJECT_CONTEXT', true, 'pageType == "INDEX_PAGE" and objectPermissions.canUpdateObjectRecords and not hasAnySoftDeleteFilterOnView and objectMetadataItem.isUICreatable and objectMetadataItem.isUIEditable'],
    ['DELETE_RECORDS', 'Delete {objectLabel}', 'Delete', 'IconTrash', 'RECORD_SELECTION', false, 'numberOfSelectedRecords >= 1 and not hasAnySoftDeleteFilterOnView and objectPermissions.canSoftDeleteObjectRecords and (isSelectAll or noneDefined(selectedRecords, "deletedAt"))'],
    ['RESTORE_RECORDS', 'Restore {objectLabel}', 'Restore', 'IconRefresh', 'RECORD_SELECTION', true, 'numberOfSelectedRecords >= 1 and (isSelectAll or everyDefined(selectedRecords, "deletedAt")) and objectPermissions.canSoftDeleteObjectRecords and (pageType == "RECORD_PAGE" or hasAnySoftDeleteFilterOnView)'],
    ['DESTROY_RECORDS', 'Permanently destroy {objectLabel}', 'Destroy', 'IconTrashX', 'RECORD_SELECTION', false, 'numberOfSelectedRecords >= 1 and objectPermissions.canDestroyObjectRecords and (isSelectAll or everyDefined(selectedRecords, "deletedAt")) and (pageType == "RECORD_PAGE" or hasAnySoftDeleteFilterOnView)'],
    ['UPDATE_MULTIPLE_RECORDS', 'Update {objectLabelPlural}', 'Update', 'IconEdit', 'RECORD_SELECTION', true, 'numberOfSelectedRecords >= 2 and objectPermissions.canUpdateObjectRecords'],
    ['IMPORT_RECORDS', 'Import {objectLabelPlural}', 'Import', 'IconFileImport', 'GLOBAL_OBJECT_CONTEXT', false, 'pageType == "INDEX_PAGE" and objectPermissions.canCreateObjectRecords and objectMetadataItem.isUICreatable and objectMetadataItem.isUIEditable'],
    ['CREATE_NEW_VIEW', 'Create View', 'Create View', 'IconLayout', 'GLOBAL_OBJECT_CONTEXT', false, 'pageType == "INDEX_PAGE" and not hasAnySoftDeleteFilterOnView'],
    ['SEE_DELETED_RECORDS', 'See deleted {objectLabelPlural}', 'Deleted {objectLabelPlural}', 'IconRotate2', 'GLOBAL_OBJECT_CONTEXT', false, 'pageType == "INDEX_PAGE" and not hasAnySoftDeleteFilterOnView'],
    ['HIDE_DELETED_RECORDS', 'Hide deleted {objectLabelPlural}', 'Hide deleted', 'IconEyeOff', 'GLOBAL_OBJECT_CONTEXT', false, 'pageType == "INDEX_PAGE" and hasAnySoftDeleteFilterOnView'],
    ['SEARCH_RECORDS', 'Search', 'Search', 'IconSearch', 'GLOBAL', false, null],
    ['SEARCH_RECORDS_FALLBACK', 'Search', 'Search', 'IconSearch', 'FALLBACK', false, null],
    ['NAVIGATE_TO_NEXT_RECORD', 'Navigate to next {objectLabelSingular}', null, 'IconChevronDown', 'RECORD_SELECTION', true, 'pageType == "RECORD_PAGE" and not isInSidePanel'],
    ['NAVIGATE_TO_PREVIOUS_RECORD', 'Navigate to previous {objectLabelSingular}', null, 'IconChevronUp', 'RECORD_SELECTION', true, 'pageType == "RECORD_PAGE" and not isInSidePanel'],
  ];
  return Promise.all(definitions.map(async ([engineComponentKey, label, shortLabel, icon, availabilityType, isPinned, conditionalAvailabilityExpression], position) => {
    const id = await compatibilityId(`command:${workspaceId}:${engineComponentKey}`);
    return { __typename: 'CommandMenuItem', id, universalIdentifier: id, applicationId: null, workflowVersionId: null, frontComponentId: null,
      frontComponent: null, engineComponentKey, label, icon, shortLabel, position, isPinned, payload: null, hotKeys: null,
      conditionalAvailabilityExpression, conditionalPinnedExpression: null, availabilityType, availabilityObjectMetadataId: null,
      navigationTargetObjectMetadataId: null, pageLayoutId: null, isActive: true };
  }));
}
