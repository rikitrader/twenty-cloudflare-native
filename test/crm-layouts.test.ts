import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { crmMetadata } from '../src/crm-metadata';
import { crmLayouts, defaultCrmLayouts, handleCrmLayouts } from '../src/crm-layouts';
import type { Env } from '../src/types';

let db: DatabaseSync;
let env: Env;
const workspace = '39fb4af1-8b4e-48ac-b76c-7974100eecbb';
const other = '33dce462-82e3-4ed3-a794-837b164e2ff0';
const owner = { subject: 'user:layout-owner', role: 'owner' };
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const prepare = (sql: string) => ({ bind(...values: unknown[]) {
    const statement = db.prepare(sql);
    return { first: async () => statement.get(...values as never[]) ?? null, all: async () => ({ results: statement.all(...values as never[]) }), run: async () => ({ success: true, meta: statement.run(...values as never[]) }) };
  } });
  env = { CRM_DB: { prepare } } as unknown as Env;
  for (const id of [workspace, other]) db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run(id, 'Layout test', '2026-01-01T00:00:00.000Z');
});
afterEach(() => db.close());
const request = async (op: string, vars: Record<string, any> = {}, actor = owner, tenant = workspace) => {
  const response = (await handleCrmLayouts(op, env, tenant, vars, actor))!;
  return { status: response.status, ...await response.json() as any };
};
const toInput = (layout: Record<string, any>) => ({ name: layout.name, type: layout.type, objectMetadataId: layout.objectMetadataId,
  isFirstTabPinned: layout.isFirstTabPinned, tabs: layout.tabs.map((tab: Record<string, any>) => ({ id: tab.id, title: tab.title,
    icon: tab.icon, position: tab.position, layoutMode: tab.layoutMode, widgets: tab.widgets.map((widget: Record<string, any>) => ({
      id: widget.id, title: widget.title, type: widget.type, pageLayoutTabId: tab.id, objectMetadataId: widget.objectMetadataId,
      configuration: widget.configuration, position: widget.position,
    })) })) });

it('supplies four record pages with real editable Fields widgets and four creation forms', async () => {
  const layouts = await defaultCrmLayouts(env, workspace);
  const objects = await crmMetadata(env, workspace);
  expect(layouts).toHaveLength(8);
  for (const layout of layouts) {
    expect(layout.__typename).toBe('PageLayout');
    expect(objects.find(object => object.id === layout.objectMetadataId)?.isSystem).toBe(false);
    expect(layout.tabs[0]).toMatchObject({ __typename: 'PageLayoutTab', pageLayoutId: layout.id, isActive: true, layoutMode: 'VERTICAL_LIST' });
    const widget = layout.tabs[0].widgets[0];
    expect(widget).toMatchObject({ __typename: 'PageLayoutWidget', pageLayoutTabId: layout.tabs[0].id, isActive: true,
      position: { __typename: 'PageLayoutWidgetVerticalListPosition', layoutMode: 'VERTICAL_LIST', index: 0 } });
    if (layout.type === 'RECORD_PAGE') expect(widget.configuration).toMatchObject({ __typename: 'FieldsConfiguration', configurationType: 'FIELDS', viewId: null, shouldAllowUserToSeeHiddenFields: true });
    else {
      const fieldIds = objects.find(object => object.id === layout.objectMetadataId)!.fieldsList.filter((field: any) => field.writability === 'OPEN').map((field: any) => field.id);
      expect(layout.tabs[0].widgets.every((field: any) => field.configuration.__typename === 'FormFieldConfiguration' && fieldIds.includes(field.configuration.fieldMetadataId))).toBe(true);
    }
  }
  expect(db.prepare('SELECT count(*) AS count FROM workspace_settings').get()).toMatchObject({ count: 0 });
});

it('matches actual FindAll and FindOne query contracts and never returns other tenants layout IDs', async () => {
  const all = await request('FindAllRecordPageLayouts');
  expect(all.data.getPageLayouts).toHaveLength(4);
  const id = all.data.getPageLayouts[0].id;
  expect((await request('FindOnePageLayout', { id })).data.getPageLayout.id).toBe(id);
  expect((await request('FindOnePageLayoutType', { id })).data.getPageLayout.type).toBe('RECORD_PAGE');
  expect((await request('FindAllRecordFormPageLayouts')).data.getPageLayouts).toHaveLength(4);
  expect((await request('FindOnePageLayout', { id }, owner, other)).status).toBe(404);
});

it('persists validated layout edits and resets them using generated GraphQL envelopes', async () => {
  const layout = (await crmLayouts(env, workspace))[0];
  const input = toInput(layout);
  input.name = 'Edited details';
  input.tabs[0].title = 'Contact details';
  const saved = await request('UpdatePageLayoutWithTabsAndWidgets', { id: layout.id, input });
  expect(saved.status).toBe(200);
  expect(saved.data.updatePageLayoutWithTabsAndWidgets.tabs[0]).toMatchObject({ title: 'Contact details', __typename: 'PageLayoutTab' });
  expect((await request('FindOnePageLayout', { id: layout.id })).data.getPageLayout.name).toBe('Edited details');
  expect((await request('ResetPageLayoutToDefault', { id: layout.id })).data.resetPageLayoutToDefault.tabs[0].title).toBe('Details');
  expect((await request('FindOnePageLayout', { id: layout.id })).data.getPageLayout.name).toBe(layout.name);
});

it('requires owner/admin for layout changes and leaves configuration untouched when denied', async () => {
  const layout = (await crmLayouts(env, workspace))[0];
  const member = { subject: 'user:member', role: 'member' };
  expect((await request('UpdatePageLayoutWithTabsAndWidgets', { id: layout.id, input: toInput(layout) }, member)).status).toBe(403);
  expect((await request('ResetPageLayoutToDefault', { id: layout.id }, member)).status).toBe(403);
  expect((await request('UpdatePageLayoutWithTabsAndWidgets', { id: layout.id, input: toInput(layout) }, owner, other)).status).toBe(404);
  expect(db.prepare('SELECT count(*) AS count FROM workspace_settings').get()).toMatchObject({ count: 0 });
});

it('rejects cross-object widgets, unsupported widget engines and malformed positions rather than claiming successful saves', async () => {
  const layout = (await crmLayouts(env, workspace))[0];
  let input = toInput(layout);
  input.tabs[0].widgets[0].objectMetadataId = (await crmMetadata(env, other))[0].id;
  expect((await request('UpdatePageLayoutWithTabsAndWidgets', { id: layout.id, input })).status).toBe(400);
  input = toInput(layout);
  input.tabs[0].widgets[0].type = 'WORKFLOW';
  expect((await request('UpdatePageLayoutWithTabsAndWidgets', { id: layout.id, input })).status).toBe(400);
  input = toInput(layout);
  input.tabs[0].widgets[0].position.index = -1;
  expect((await request('UpdatePageLayoutWithTabsAndWidgets', { id: layout.id, input })).status).toBe(400);
  expect(db.prepare('SELECT count(*) AS count FROM workspace_settings').get()).toMatchObject({ count: 0 });
});

it('validates creation-form field ownership and preserves legacy records without destructive rewrites', async () => {
  const layout = (await crmLayouts(env, workspace)).find(layout => layout.type === 'RECORD_FORM')!;
  const input = toInput(layout);
  input.tabs[0].widgets[0].configuration.fieldMetadataId = (await crmMetadata(env, other))[0].fieldsList[0].id;
  expect((await request('UpdatePageLayoutWithTabsAndWidgets', { id: layout.id, input })).status).toBe(400);
  db.prepare('INSERT INTO workspace_settings (workspace_id,setting_key,value_json,updated_at,updated_by) VALUES (?,?,?,?,?)')
    .run(workspace, 'pageLayouts', '[{"id":"legacy-invalid","tabs":[]}]', '2026-01-01', owner.subject);
  expect(await crmLayouts(env, workspace)).toHaveLength(8);
  expect(db.prepare("SELECT value_json FROM workspace_settings WHERE setting_key='pageLayouts'").get()).toMatchObject({ value_json: '[{"id":"legacy-invalid","tabs":[]}]' });
});

it('uses an exact allowlist and never intercepts DPA or unrelated operations', async () => {
  expect(await handleCrmLayouts('SignDpa', env, workspace, {}, owner)).toBeNull();
  expect(await handleCrmLayouts('UpdatePageLayoutWithTabsAndWidgetsAndDeleteUsers', env, workspace, {}, owner)).toBeNull();
});

it.each(['empty-tabs', 'missing-name', 'empty-configuration', 'foreign-view', 'foreign-field', 'duplicate-widget', 'bad-position', 'unsupported-widget'])('ignores malformed stored %s layouts without deleting their data', async mode => {
  const baseline = (await defaultCrmLayouts(env, workspace))[mode === 'foreign-field' ? 1 : 0];
  const malformed = structuredClone(baseline);
  const widget = malformed.tabs[0].widgets[0];
  if (mode === 'empty-tabs') malformed.tabs = [];
  if (mode === 'missing-name') delete malformed.name;
  if (mode === 'empty-configuration') widget.configuration = {};
  if (mode === 'foreign-view') widget.configuration.viewId = crypto.randomUUID();
  if (mode === 'foreign-field') widget.configuration.fieldMetadataId = (await crmMetadata(env, other))[0].fieldsList[1].id;
  if (mode === 'duplicate-widget') malformed.tabs[0].widgets.push(structuredClone(widget));
  if (mode === 'bad-position') widget.position.index = -4;
  if (mode === 'unsupported-widget') widget.type = 'WORKFLOW';
  const raw = JSON.stringify(malformed);
  db.prepare('INSERT INTO workspace_settings (workspace_id,setting_key,value_json,updated_at,updated_by) VALUES (?,?,?,?,?)')
    .run(workspace, `crm.layout:${baseline.id}`, raw, '2026-01-01', owner.subject);
  expect((await crmLayouts(env, workspace)).find(layout => layout.id === baseline.id)).toEqual(baseline);
  expect(db.prepare('SELECT value_json FROM workspace_settings WHERE workspace_id = ? AND setting_key = ?').get(workspace, `crm.layout:${baseline.id}`)).toMatchObject({ value_json: raw });
});

it('validates legacy documents and reconstructs missing GraphQL union typenames', async () => {
  const baseline = (await defaultCrmLayouts(env, workspace))[0];
  const stored = JSON.parse(JSON.stringify(baseline, (key, value) => key === '__typename' ? undefined : value));
  stored.name = 'Existing native layout';
  db.prepare('INSERT INTO workspace_settings (workspace_id,setting_key,value_json,updated_at,updated_by) VALUES (?,?,?,?,?)')
    .run(workspace, 'pageLayouts', JSON.stringify([stored]), '2026-01-01', owner.subject);
  const loaded = (await crmLayouts(env, workspace))[0];
  expect(loaded.name).toBe('Existing native layout');
  expect(loaded.tabs[0].widgets[0].configuration.__typename).toBe('FieldsConfiguration');
  expect(loaded.tabs[0].widgets[0].position.__typename).toBe('PageLayoutWidgetVerticalListPosition');
  expect(loaded.updatedAt).toBe(baseline.updatedAt);
});
