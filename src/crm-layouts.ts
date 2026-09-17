import type { Env } from './types';
import { compatibilityId } from './compatibility-id';
import { crmMetadata, crmViews, parseMetadataJson, type MetadataRow as Row } from './crm-metadata';

type Actor = { subject: string; role: string };
const readOperations = new Set(['FindAllRecordPageLayouts', 'FindAllRecordFormPageLayouts', 'FindOnePageLayout', 'FindOnePageLayoutType']);
const writeOperations = new Set(['UpdatePageLayoutWithTabsAndWidgets', 'ResetPageLayoutToDefault']);
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const response = (key: string, value: unknown) => Response.json({ data: { [key]: value } });
const failure = (message: string, status = 400) => Response.json({ errors: [{ message }] }, { status });

/** Real upstream PageLayout/FieldsConfiguration/FormFieldConfiguration shapes.
 * Fields widgets edit records through Twenty's normal record mutation hooks.
 * Form layouts are inert unless the separately managed creation-form flag is on. */
export async function defaultCrmLayouts(env: Env, workspaceId: string, metadata?: Row[]): Promise<Row[]> {
  const objects = (metadata ?? await crmMetadata(env, workspaceId)).filter(object => !object.isSystem);
  const layouts: Row[] = [];
  for (const object of objects) {
    for (const type of ['RECORD_PAGE', 'RECORD_FORM']) {
      const id = await compatibilityId(`layout:${workspaceId}:${object.nameSingular}:${type}`);
      const tabId = await compatibilityId(`layout-tab:${id}:details`);
      const timestamp = object.createdAt;
      const widgets: Row[] = [];
      const fields: (Row | null)[] = type === 'RECORD_PAGE' ? [null] : object.fieldsList.filter((field: Row) => field.isActive && field.writability === 'OPEN' && field.isUIEditable && field.relation?.type !== 'ONE_TO_MANY');
      for (const [index, field] of fields.entries()) {
        const widgetId = await compatibilityId(`layout-widget:${id}:${field?.id ?? 'fields'}`);
        widgets.push({ __typename: 'PageLayoutWidget', id: widgetId, universalIdentifier: widgetId, applicationId: null,
          isSystemSideEffect: false, title: field?.label ?? 'Fields', type: field ? 'FORM_FIELD' : 'FIELDS', objectMetadataId: object.id,
          createdAt: timestamp, updatedAt: timestamp, deletedAt: null, isActive: true, conditionalDisplay: null, conditionalAvailabilityExpression: null,
          gridPosition: null, position: { __typename: 'PageLayoutWidgetVerticalListPosition', layoutMode: 'VERTICAL_LIST', index, heightBehavior: 'FIT_CONTENT' },
          configuration: field ? { __typename: 'FormFieldConfiguration', configurationType: 'FORM_FIELD', fieldMetadataId: field.id }
            : { __typename: 'FieldsConfiguration', configurationType: 'FIELDS', viewId: null, newFieldDefaultVisibility: true, shouldAllowUserToSeeHiddenFields: true },
          pageLayoutTabId: tabId });
      }
      layouts.push({ __typename: 'PageLayout', id, universalIdentifier: id, applicationId: null,
        name: `${object.labelSingular} ${type === 'RECORD_FORM' ? 'creation form' : 'record page'}`, objectMetadataId: object.id, type,
        isSystemSideEffect: false, isFirstTabPinned: false, defaultTabToFocusOnMobileAndSidePanelId: tabId,
        createdAt: timestamp, updatedAt: timestamp, deletedAt: null,
        tabs: [{ __typename: 'PageLayoutTab', id: tabId, universalIdentifier: tabId, applicationId: null, isSystemSideEffect: false,
          title: 'Details', icon: 'IconListDetails', position: 0, layoutMode: 'VERTICAL_LIST', widgets, pageLayoutId: id,
          isActive: true, createdAt: timestamp, updatedAt: timestamp, deletedAt: null }] });
    }
  }
  return layouts;
}

function validatedStoredLayout(candidate: unknown, baseline: Row, object: Row, views: Row[]): Row | null {
  if (candidate === null || typeof candidate !== 'object') return null;
  const layout = candidate as Row;
  if (!uuid(layout.id) || layout.objectMetadataId !== object.id || layout.type !== baseline.type ||
      typeof layout.createdAt !== 'string' || !Number.isFinite(Date.parse(layout.createdAt)) ||
      typeof layout.updatedAt !== 'string' || !Number.isFinite(Date.parse(layout.updatedAt)) ||
      !Array.isArray(layout.tabs)) return null;
  try {
    // Stored documents have exactly the same trust boundary as mutation inputs.
    // Rebuild GraphQL union typenames instead of trusting persisted JSON to carry
    // them, and validate every field/view/child ID against this tenant's metadata.
    const normalized = normalizeUpdate(layout, { ...baseline, id: layout.id, universalIdentifier: layout.id }, object, views, layout.updatedAt);
    if (layout.tabs.some((tab: Row) => tab.pageLayoutId !== layout.id || tab.isActive !== true ||
      tab.widgets.some((widget: Row) => widget.isActive !== true))) return null;
    normalized.createdAt = layout.createdAt;
    normalized.updatedAt = layout.updatedAt;
    return normalized;
  } catch { return null; }
}

export async function crmLayouts(env: Env, workspaceId: string, metadata?: Row[]): Promise<Row[]> {
  const objects = metadata ?? await crmMetadata(env, workspaceId);
  const defaults = await defaultCrmLayouts(env, workspaceId, objects);
  // Existing valid layout records remain in effect. Malformed legacy records are
  // not deleted; they cannot satisfy the native GraphQL layout contract.
  const legacy = await env.CRM_DB!.prepare("SELECT value_json FROM workspace_settings WHERE workspace_id = ? AND setting_key = 'pageLayouts'").bind(workspaceId).first<{ value_json: string }>();
  const raw = parseMetadataJson(legacy?.value_json, {});
  const legacyLayouts: Row[] = raw !== null && typeof raw === 'object' ? Object.values(raw) : [];
  const overrides = await env.CRM_DB!.prepare("SELECT setting_key,value_json FROM workspace_settings WHERE workspace_id = ? AND setting_key LIKE 'crm.layout:%'").bind(workspaceId).all<Row>();
  const views = legacyLayouts.length || overrides.results.length ? await crmViews(env, workspaceId, objects) : [];
  return defaults.map(defaultLayout => {
    const object = objects.find(object => object.id === defaultLayout.objectMetadataId)!;
    let layout = legacyLayouts.map(candidate => validatedStoredLayout(candidate, defaultLayout, object, views)).find(Boolean) ?? defaultLayout;
    const stored = overrides.results.find(row => row.setting_key === `crm.layout:${layout.id}`);
    const candidate = parseMetadataJson(stored?.value_json, null);
    const validated = validatedStoredLayout(candidate, layout, object, views);
    if (validated && validated.id === layout.id) layout = validated;
    return { ...layout, __typename: 'PageLayout' };
  });
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 160) throw new Error(`${name} must contain 1–160 characters`);
  return value;
}

function normalizePosition(input: unknown, mode: string, index: number): Row {
  const position = input !== null && typeof input === 'object' ? input as Row : { layoutMode: mode, index };
  if (position.layoutMode !== mode) throw new Error('Widget position must match its tab layout mode');
  if (mode === 'VERTICAL_LIST') {
    if (!Number.isSafeInteger(position.index) || position.index < 0 || position.index > 1000) throw new Error('Invalid vertical-list position');
    if (position.heightBehavior != null && !['FIT_CONTENT', 'TAB_VIEWPORT'].includes(position.heightBehavior)) throw new Error('Invalid widget height behavior');
    return { __typename: 'PageLayoutWidgetVerticalListPosition', layoutMode: mode, index: position.index, heightBehavior: position.heightBehavior ?? 'FIT_CONTENT' };
  }
  for (const key of ['column', 'row', 'columnSpan', 'rowSpan']) if (!Number.isSafeInteger(position[key]) || position[key] < (key.endsWith('Span') ? 1 : 0) || position[key] > 1000) throw new Error('Invalid widget grid position');
  return { __typename: 'PageLayoutWidgetGridPosition', layoutMode: mode, column: position.column, row: position.row, columnSpan: position.columnSpan, rowSpan: position.rowSpan };
}

function normalizeUpdate(input: Row, current: Row, object: Row, views: Row[], timestamp = new Date().toISOString()): Row {
  if (input.type !== current.type || input.objectMetadataId != null && input.objectMetadataId !== object.id) throw new Error('A layout cannot be moved to another object or type');
  if (!Array.isArray(input.tabs) || input.tabs.length === 0 || input.tabs.length > 20) throw new Error('A layout requires 1–20 tabs');
  const now = timestamp;
  const ids = new Set<string>([current.id]);
  const claimId = (id: unknown) => { if (!uuid(id) || ids.has(id)) throw new Error('Layout IDs must be valid and distinct'); ids.add(id); return id; };
  const tabs = input.tabs.map((tab: Row, tabIndex: number) => {
    if (tab === null || typeof tab !== 'object') throw new Error('Invalid tab');
    const id = claimId(tab.id);
    const mode = tab.layoutMode ?? 'VERTICAL_LIST';
    if (!['VERTICAL_LIST', 'GRID'].includes(mode)) throw new Error('Supported layout modes are VERTICAL_LIST and GRID');
    if (!Number.isFinite(tab.position) || tab.position < 0) throw new Error('Invalid tab position');
    if (!Array.isArray(tab.widgets) || tab.widgets.length > 100) throw new Error('A tab may contain at most 100 widgets');
    const oldTab = current.tabs.find((item: Row) => item.id === id);
    const widgets = tab.widgets.map((widget: Row, index: number) => {
      if (widget === null || typeof widget !== 'object') throw new Error('Invalid widget');
      const widgetId = claimId(widget.id);
      if (widget.pageLayoutTabId !== id || widget.objectMetadataId != null && widget.objectMetadataId !== object.id) throw new Error('Widget must belong to its tab and object');
      if (widget.conditionalDisplay != null || widget.conditionalAvailabilityExpression != null) throw new Error('Conditional widget rules are not supported by this layout adapter');
      const config = widget.configuration;
      if (config === null || typeof config !== 'object') throw new Error('Widget configuration required');
      let configuration: Row;
      if (current.type === 'RECORD_PAGE' && widget.type === 'FIELDS' && config.configurationType === 'FIELDS') {
        if (config.viewId != null && !views.some(view => view.id === config.viewId && view.objectMetadataId === object.id)) throw new Error('Fields view not found in this object');
        configuration = { __typename: 'FieldsConfiguration', configurationType: 'FIELDS', viewId: config.viewId ?? null,
          newFieldDefaultVisibility: config.newFieldDefaultVisibility !== false, shouldAllowUserToSeeHiddenFields: config.shouldAllowUserToSeeHiddenFields === true };
      } else if (current.type === 'RECORD_FORM' && widget.type === 'FORM_FIELD' && config.configurationType === 'FORM_FIELD') {
        if (!object.fieldsList.some((field: Row) => field.id === config.fieldMetadataId && field.writability === 'OPEN' && field.isUIEditable)) throw new Error('Editable field not found in this object');
        configuration = { __typename: 'FormFieldConfiguration', configurationType: 'FORM_FIELD', fieldMetadataId: config.fieldMetadataId };
      } else throw new Error('Only native FIELDS and FORM_FIELD widgets are currently supported');
      const old = oldTab?.widgets.find((item: Row) => item.id === widgetId);
      const position = normalizePosition(widget.position, mode, index);
      return { __typename: 'PageLayoutWidget', id: widgetId, universalIdentifier: widgetId, applicationId: null, isSystemSideEffect: false,
        title: text(widget.title, 'Widget title'), type: widget.type, objectMetadataId: object.id, pageLayoutTabId: id,
        createdAt: old?.createdAt ?? now, updatedAt: now, deletedAt: null, isActive: true, conditionalDisplay: null, conditionalAvailabilityExpression: null,
        position, gridPosition: mode === 'GRID' ? { __typename: 'GridPosition', column: position.column, row: position.row, columnSpan: position.columnSpan, rowSpan: position.rowSpan } : null, configuration };
    });
    return { __typename: 'PageLayoutTab', id, universalIdentifier: id, applicationId: null, isSystemSideEffect: false,
      title: text(tab.title, 'Tab title'), icon: typeof tab.icon === 'string' ? tab.icon.slice(0, 80) : null, position: tab.position ?? tabIndex,
      layoutMode: mode, widgets, pageLayoutId: current.id, isActive: true, createdAt: oldTab?.createdAt ?? now, updatedAt: now, deletedAt: null };
  });
  return { ...current, name: text(input.name, 'Layout name'), isFirstTabPinned: input.isFirstTabPinned === true, tabs,
    defaultTabToFocusOnMobileAndSidePanelId: tabs.some((tab: Row) => tab.id === current.defaultTabToFocusOnMobileAndSidePanelId) ? current.defaultTabToFocusOnMobileAndSidePanelId : tabs[0].id, updatedAt: now };
}

/** Invoke after workspace membership authorization, before legacy broad regex
 * dispatchers or workspaceBootstrap (which historically intercepted these reads). */
export async function handleCrmLayouts(op: string, env: Env, workspaceId: string, vars: Row = {}, actor?: Actor): Promise<Response | null> {
  if (!readOperations.has(op) && !writeOperations.has(op)) return null;
  const objects = await crmMetadata(env, workspaceId);
  const layouts = await crmLayouts(env, workspaceId, objects);
  if (op === 'FindAllRecordPageLayouts' || op === 'FindAllRecordFormPageLayouts') return response('getPageLayouts', layouts.filter(layout => layout.type === (op === 'FindAllRecordPageLayouts' ? 'RECORD_PAGE' : 'RECORD_FORM')));
  const current = layouts.find(layout => layout.id === vars.id);
  if (!current) return failure('Page layout not found', 404);
  if (readOperations.has(op)) return response('getPageLayout', current);
  if (!actor || !['owner', 'admin'].includes(actor.role)) return failure('Workspace administrator required', 403);
  let updated: Row;
  if (op === 'ResetPageLayoutToDefault') {
    const defaults = await defaultCrmLayouts(env, workspaceId, objects);
    updated = defaults.find(layout => layout.objectMetadataId === current.objectMetadataId && layout.type === current.type)!;
    updated.id = current.id;
    updated.universalIdentifier = current.id;
    updated.tabs.forEach((tab: Row) => { tab.pageLayoutId = current.id; });
  } else {
    try { updated = normalizeUpdate(vars.input ?? {}, current, objects.find(object => object.id === current.objectMetadataId)!, await crmViews(env, workspaceId, objects)); }
    catch (error) { return failure(error instanceof Error ? error.message : 'Invalid page layout'); }
  }
  await env.CRM_DB!.prepare('INSERT INTO workspace_settings (workspace_id,setting_key,value_json,updated_at,updated_by) VALUES (?,?,?,?,?) ON CONFLICT(workspace_id,setting_key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at,updated_by=excluded.updated_by')
    .bind(workspaceId, `crm.layout:${current.id}`, JSON.stringify(updated), new Date().toISOString(), actor.subject).run();
  return response(op === 'ResetPageLayoutToDefault' ? 'resetPageLayoutToDefault' : 'updatePageLayoutWithTabsAndWidgets', updated);
}
