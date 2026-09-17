import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { crmCommands, crmMetadata, crmNavigation, crmViews } from '../src/crm-metadata';
import { compatibilityId } from '../src/compatibility-id';
import { workspaceBootstrap } from '../src/workspace-bootstrap';
import type { Env } from '../src/types';

let db: DatabaseSync;
let env: Env;
const owner = { subject: 'user:metadata-owner', role: 'owner' };
const member = { subject: 'user:metadata-member', role: 'member' };
const workspace = '39fb4af1-8b4e-48ac-b76c-7974100eecbb';
const other = '33dce462-82e3-4ed3-a794-837b164e2ff0';
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  const prepare = (sql: string) => ({ bind(...values: unknown[]) {
    const statement = db.prepare(sql);
    return { first: async () => statement.get(...values as never[]) ?? null, all: async () => ({ results: statement.all(...values as never[]) }), run: async () => ({ success: true, meta: statement.run(...values as never[]) }) };
  } });
  env = { CRM_DB: { prepare, batch: async (statements: { run: () => Promise<unknown> }[]) => {
    db.exec('BEGIN');
    try { const output = []; for (const statement of statements) output.push(await statement.run()); db.exec('COMMIT'); return output; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } } } as unknown as Env;
  for (const id of [workspace, other]) db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run(id, 'Metadata test', '2026-01-01T00:00:00.000Z');
});
afterEach(() => db.close());
const request = async (op: string, vars: Record<string, any> = {}, actor = owner, tenant = workspace) => {
  const response = (await workspaceBootstrap(op, env, tenant, vars, actor))!;
  return { status: response.status, ...await response.json() as any };
};
const objects = () => crmMetadata(env, workspace);
const views = async () => crmViews(env, workspace, await objects());

it('provides real standard object fields, coherent inverse relations and UUID metadata identifiers', async () => {
  const all = await objects();
  expect(all.filter(object => !object.isSystem).map(object => object.nameSingular)).toEqual(['person', 'company', 'opportunity', 'activity']);
  for (const object of all) {
    expect(object.isSystem).toBe(['workspaceMember', 'blocklist', 'workflowVersion', 'workflow', 'attachment', 'task', 'note', 'taskTarget', 'noteTarget'].includes(object.nameSingular));
    expect(object.fieldsList.some((field: any) => field.id === object.labelIdentifierFieldMetadataId)).toBe(true);
    for (const field of object.fieldsList) {
      expect(field.id).toMatch(/^[a-f\d-]{36}$/);
      if (field.relation) {
        const target = all.find(item => item.id === field.relation.targetObjectMetadata.id)!;
        expect(target.fieldsList.some((item: any) => item.id === field.relation.targetFieldMetadata.id), `${object.nameSingular}.${field.name} -> ${target.nameSingular}.${field.relation.targetFieldMetadata.name}`).toBe(true);
      }
    }
  }
  expect(all[0].fieldsList.map((field: any) => field.name)).not.toContain('jobTitle');
  expect(all[2].fieldsList.find((field: any) => field.name === 'amount').type).toBe('NUMBER');
  for (const [sourceName, targetName] of [['task', 'taskTarget'], ['note', 'noteTarget']] as const) {
    const source = all.find(object => object.nameSingular === sourceName)!;
    const junction = all.find(object => object.nameSingular === targetName)!;
    const sourceTargets = source.fieldsList.find((field: any) => field.name === `${sourceName}Targets`)!;
    const morphTarget = junction.fieldsList.find((field: any) => field.name === 'target')!;
    expect(sourceTargets.settings.junctionTargetFieldId).toBe(morphTarget.id);
    expect(morphTarget.type).toBe('MORPH_RELATION');
    expect(morphTarget.morphRelations.map((relation: any) => relation.targetObjectMetadata.nameSingular)).toEqual(['person', 'company', 'opportunity']);
  }
});

it('uses the exact upstream OPEN enum for editable objects and fields, retaining SYSTEM for internal data', async () => {
  db.prepare('INSERT INTO custom_fields (id,workspace_id,object_type,field_key,label,field_type,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), workspace, 'contact', 'region', 'Region', 'text', '2026-01-01');
  for (const object of await objects()) {
    const writableSystem = ['task', 'note', 'taskTarget', 'noteTarget', 'blocklist'].includes(object.nameSingular);
    expect(object.writability).toBe(object.isSystem && !writableSystem ? 'SYSTEM' : 'OPEN');
    for (const field of object.fieldsList) {
      const editable = (!object.isSystem || writableSystem) && !['id', 'createdAt', 'updatedAt', 'deletedAt'].includes(field.name) && field.relation?.type !== 'ONE_TO_MANY';
      expect(field.writability).toBe(editable ? 'OPEN' : 'SYSTEM');
      expect(field.isUIEditable).toBe(editable);
    }
  }
});

it('bootstraps four table views with usable field columns and sidebar object links without inserting CRM records', async () => {
  const all = await objects();
  const defaultViews = await views();
  expect(defaultViews).toHaveLength(4);
  expect(defaultViews.every(view => view.key === 'INDEX' && view.type === 'TABLE')).toBe(true);
  for (const view of defaultViews) {
    expect(view.viewFields.filter((field: any) => field.isVisible).length).toBeGreaterThan(1);
    expect(view.viewFields.every((field: any) => field.viewId === view.id)).toBe(true);
  }
  const nav = await crmNavigation(env, workspace, all);
  expect(nav.map(item => item.type)).toEqual(['OBJECT', 'OBJECT', 'OBJECT', 'OBJECT']);
  expect(nav.map(item => item.targetObjectMetadataId)).toEqual(all.filter(object => !object.isSystem).map(object => object.id));
  expect(db.prepare('SELECT count(*) AS count FROM contacts').get()).toMatchObject({ count: 0 });
  expect(db.prepare('SELECT count(*) AS count FROM saved_views').get()).toMatchObject({ count: 0 });
  expect((await request('FindMinimalMetadata')).data.minimalMetadata.views).toHaveLength(4);
});

it('repairs incomplete legacy sidebar snapshots without overriding current tombstones', async () => {
  const all = await objects();
  const defaults = await crmNavigation(env, workspace, all);
  const activity = defaults.find(item => item.name === 'Activities')!;
  db.prepare('INSERT INTO workspace_settings VALUES (?,?,?,?,?)').run(workspace, 'navigationMenuItems', JSON.stringify([activity]), '2026-01-01', owner.subject);
  expect((await crmNavigation(env, workspace, all)).map(item => item.name)).toEqual(['People', 'Companies', 'Opportunities', 'Activities']);
  const people = defaults.find(item => item.name === 'People')!;
  db.prepare('INSERT INTO workspace_settings VALUES (?,?,?,?,?)').run(workspace, `crm.navigation-item:${people.id}`, 'null', '2026-01-02', owner.subject);
  expect((await crmNavigation(env, workspace, all)).map(item => item.name)).toEqual(['Companies', 'Opportunities', 'Activities']);
});

it('filters generated view queries by object and exact view type', async () => {
  const all = await objects();
  expect((await request('FindManyViews', { objectMetadataId: all[1].id, viewTypes: ['TABLE'] })).data.getViews).toHaveLength(1);
  expect((await request('FindFieldsWidgetViews')).data.getViews).toEqual([]);
  expect((await request('FindManyViews', { objectMetadataId: (await crmMetadata(env, other))[0].id })).data.getViews).toEqual([]);
});

it('persists generated CreateView/UpdateView/DestroyView contracts without returning another workspace view', async () => {
  const object = (await objects())[0];
  const created = await request('CreateView', { input: { id: crypto.randomUUID(), name: 'Customers', icon: 'IconUser', objectMetadataId: object.id, type: 'TABLE' } });
  expect(created.status).toBe(200);
  const view = created.data.createView;
  expect(view.viewFields).toEqual([]);
  expect((await request('UpdateView', { id: view.id, input: { name: 'Active customers' } })).data.updateView.name).toBe('Active customers');
  expect((await views()).find(item => item.id === view.id)?.name).toBe('Active customers');
  expect((await request('UpdateView', { id: view.id, input: { name: 'Cross-tenant' } }, owner, other)).status).toBe(404);
  expect((await request('DestroyView', { id: view.id })).data.destroyView).toBe(view.id);
  expect((await views()).find(item => item.id === view.id)).toBeUndefined();
});

it('persists default column visibility/size edits and rejects another objects field', async () => {
  const initial = await views();
  const view = initial[0];
  const column = view.viewFields[0];
  expect((await request('UpdateViewField', { input: { id: column.id, update: { isVisible: false, size: 321 } } })).data.updateViewField).toMatchObject({ id: column.id, isVisible: false, size: 321 });
  expect((await views())[0].viewFields.find((field: any) => field.id === column.id)).toMatchObject({ isVisible: false, size: 321 });
  expect((await request('CreateManyViewFields', { inputs: [{ viewId: view.id, fieldMetadataId: initial[1].viewFields[0].fieldMetadataId }] })).status).toBe(400);
});

it('persists filter and sort child contracts, including multiple separate writes without overwriting earlier items', async () => {
  const view = (await views())[0];
  const fieldMetadataId = view.viewFields[0].fieldMetadataId;
  const first = await request('CreateViewFilter', { input: { viewId: view.id, fieldMetadataId, operand: 'CONTAINS', value: 'Alex' } });
  const second = await request('CreateViewFilter', { input: { viewId: view.id, fieldMetadataId, operand: 'IS_NOT_EMPTY', value: '' } });
  const sort = await request('CreateViewSort', { input: { viewId: view.id, fieldMetadataId, direction: 'DESC' } });
  expect((await views())[0].viewFilters).toHaveLength(2);
  expect((await views())[0].viewSorts[0]).toMatchObject({ direction: 'DESC', __typename: 'ViewSort' });
  const id = first.data.createViewFilter.id;
  expect((await request('UpdateViewFilter', { input: { id, update: { value: 'Jordan' } } })).data.updateViewFilter.value).toBe('Jordan');
  expect((await request('DestroyViewFilter', { input: { id } })).data.destroyViewFilter.id).toBe(id);
  expect((await views())[0].viewFilters.map((filter: any) => filter.id)).toEqual([second.data.createViewFilter.id]);
  expect((await request('DestroyViewSort', { input: { id: sort.data.createViewSort.id } })).data.destroyViewSort).toBe(sort.data.createViewSort.id);
});

it('refuses default view deletion and unknown exact operation names', async () => {
  expect((await request('DestroyView', { id: (await views())[0].id })).status).toBe(400);
  expect(await workspaceBootstrap('FindAllViewsAndDeleteUsers', env, workspace, {}, owner)).toBeNull();
});

it('persists sidebar order and requires administrator for shared workspace edits', async () => {
  const nav = (await request('FindManyNavigationMenuItems')).data.navigationMenuItems;
  const vars = { inputs: [{ id: nav[0].id, update: { position: 5, name: 'My people' } }] };
  expect((await request('UpdateManyNavigationMenuItems', vars, member)).status).toBe(403);
  expect((await request('UpdateManyNavigationMenuItems', vars)).data.updateManyNavigationMenuItems[0].position).toBe(5);
  expect((await request('FindManyNavigationMenuItems')).data.navigationMenuItems[0].name).not.toBeUndefined();
  expect((await request('UpdateManyNavigationMenuItems', vars, owner, other)).status).toBe(404);
});

it('isolates personal navigation items to their user and rejects executable links', async () => {
  const userWorkspaceId = await compatibilityId(`member:${workspace}:${member.subject}`);
  const item = { type: 'LINK', link: 'https://example.test', name: 'Personal', userWorkspaceId };
  const created = await request('CreateManyNavigationMenuItems', { inputs: [item] }, member);
  expect(created.status).toBe(200);
  expect((await request('FindManyNavigationMenuItems', {}, member)).data.navigationMenuItems).toHaveLength(5);
  expect((await request('FindManyNavigationMenuItems')).data.navigationMenuItems).toHaveLength(4);
  expect((await request('CreateManyNavigationMenuItems', { inputs: [{ ...item, link: 'javascript:alert(1)' }] }, member)).status).toBe(400);
  expect((await request('DeleteManyNavigationMenuItems', { ids: [created.data.createManyNavigationMenuItems[0].id] })).status).toBe(403);
});

it('does not lose personal navigation additions from simultaneous requests', async () => {
  // D1 serializes atomic batches. Both handlers may still read the same initial
  // metadata before their separate batches reach D1.
  const batch = env.CRM_DB!.batch.bind(env.CRM_DB);
  let previous = Promise.resolve<unknown>(null);
  env.CRM_DB!.batch = ((statements: any) => {
    const next = previous.then(() => batch(statements));
    previous = next;
    return next;
  }) as typeof env.CRM_DB.batch;
  const one = { subject: 'user:one', role: 'member' };
  const two = { subject: 'user:two', role: 'member' };
  const [first, second] = await Promise.all([one, two].map(async actor => request('CreateManyNavigationMenuItems', { inputs: [{
    type: 'LINK', name: actor.subject, link: 'https://example.test', userWorkspaceId: await compatibilityId(`member:${workspace}:${actor.subject}`),
  }] }, actor)));
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect((await request('FindManyNavigationMenuItems', {}, one)).data.navigationMenuItems.map((item: any) => item.name)).toContain(one.subject);
  expect((await request('FindManyNavigationMenuItems', {}, two)).data.navigationMenuItems.map((item: any) => item.name)).toContain(two.subject);
});

it('custom field creation maps metadata UUID to native type and supports reload, rename and removal', async () => {
  const object = (await objects())[0];
  const input = { field: { objectMetadataId: object.id, name: 'region', label: 'Region', type: 'SELECT', options: ['North', 'South'] } };
  expect((await request('CreateOneFieldMetadataItem', { input }, member)).status).toBe(403);
  const created = await request('CreateOneFieldMetadataItem', { input });
  expect(created.status).toBe(200);
  const id = created.data.createOneField.id;
  expect(db.prepare('SELECT object_type FROM custom_fields WHERE id = ?').get(id)).toMatchObject({ object_type: 'contact' });
  expect((await objects())[0].fieldsList.find((field: any) => field.id === id).options[0]).toMatchObject({ value: 'North', label: 'North' });
  expect((await request('UpdateOneFieldMetadataItem', { idToUpdate: id, updatePayload: { label: 'Territory' } })).data.updateOneField.label).toBe('Territory');
  expect((await request('DeleteOneFieldMetadataItem', { idToDelete: id }, owner, other)).status).toBe(404);
  expect((await request('DeleteOneFieldMetadataItem', { idToDelete: id })).data.deleteOneField.id).toBe(id);
  expect((await objects())[0].fieldsList.some((field: any) => field.id === id)).toBe(false);
});

it('supports the exact object settings translation and update contracts used by the upstream editor', async () => {
  const company = (await objects()).find(object => object.nameSingular === 'company')!;
  expect((await request('MetadataTranslations', { input: { objectMetadataId: company.id, locale: 'es-ES' } })).data.metadataTranslations).toEqual([]);
  expect((await request('UpdateOneObjectMetadataItem', { idToUpdate: company.id, updatePayload: { labelSingular: 'Empresa', labelPlural: 'Empresas' } }, member)).status).toBe(403);
  const updated = await request('UpdateOneObjectMetadataItem', { idToUpdate: company.id, updatePayload: {
    labelSingular: 'Empresa', labelPlural: 'Empresas', description: 'Organizaciones', openRecordIn: 'RECORD_PAGE',
    translations: [{ locale: 'es-ES', property: 'labelPlural', value: 'Empresas' }],
  } });
  expect(updated.status).toBe(200);
  expect(updated.data.updateOneObject).toMatchObject({ id: company.id, labelSingular: 'Empresa', labelPlural: 'Empresas', description: 'Organizaciones', openRecordIn: 'RECORD_PAGE' });
  expect((await objects()).find(object => object.id === company.id)).toMatchObject({ labelSingular: 'Empresa', labelPlural: 'Empresas' });
  expect((await request('MetadataTranslations', { input: { objectMetadataId: company.id, locale: 'es-ES' } })).data.metadataTranslations).toEqual([
    expect.objectContaining({ objectMetadataId: company.id, property: 'labelPlural', locale: 'es-ES', value: 'Empresas' }),
  ]);
  expect((await request('UpdateOneObjectMetadataItem', { idToUpdate: company.id, updatePayload: { labelPlural: 'Cross tenant' } }, owner, other)).status).toBe(404);
});

it('includes tenant custom objects in metadata, default views, and navigation', async () => {
  const objectId = crypto.randomUUID();
  const fieldId = crypto.randomUUID();
  db.prepare('INSERT INTO custom_objects (id,workspace_id,object_key,label,plural_label,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
    .run(objectId, workspace, 'petition', 'Petition', 'Petitions', '2026-01-02', '2026-01-02');
  db.prepare('INSERT INTO custom_fields (id,workspace_id,object_type,field_key,label,field_type,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(fieldId, workspace, 'petition', 'headline', 'Headline', 'text', '2026-01-02');
  const all = await objects();
  const petition = all.find(object => object.id === objectId)!;
  expect(petition).toMatchObject({ nameSingular: 'petition', namePlural: 'petitions', labelSingular: 'Petition', labelPlural: 'Petitions', isCustom: true, isSystem: false, writability: 'OPEN' });
  expect(petition.fieldsList.find((field: any) => field.id === fieldId)).toMatchObject({ name: 'headline', type: 'TEXT', writability: 'OPEN' });
  expect(petition.labelIdentifierFieldMetadataId).toBe(fieldId);
  expect((await views()).find(view => view.objectMetadataId === objectId)?.name).toBe('All Petitions');
  expect((await crmNavigation(env, workspace, all)).find(item => item.targetObjectMetadataId === objectId)?.name).toBe('Petitions');
  expect((await crmMetadata(env, other)).some(object => object.id === objectId)).toBe(false);
});

it('sanitizes historically malformed custom options rather than crashing bootstrap', async () => {
  db.prepare('INSERT INTO custom_fields (id,workspace_id,object_type,field_key,label,field_type,options_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(crypto.randomUUID(), workspace, 'contact', 'brokenOptions', 'Options', 'select', '[null,3,"Valid",{"value":"OK","label":"Okay"}]', '2026-01-01');
  const field = (await objects())[0].fieldsList.find((field: any) => field.name === 'brokenOptions');
  expect(field.options.map((option: any) => option.value)).toEqual(['Valid', 'OK']);
});

it('provides real engine commands with exact button contracts and availability conditions', async () => {
  const commands = await crmCommands(workspace);
  expect(commands.find(command => command.engineComponentKey === 'CREATE_NEW_RECORD')).toMatchObject({ __typename: 'CommandMenuItem', availabilityType: 'GLOBAL_OBJECT_CONTEXT', isPinned: true, frontComponentId: null });
  expect(commands.find(command => command.engineComponentKey === 'DELETE_RECORDS').conditionalAvailabilityExpression).toContain('canSoftDeleteObjectRecords');
  expect(commands.find(command => command.engineComponentKey === 'IMPORT_RECORDS')).toMatchObject({ availabilityType: 'GLOBAL_OBJECT_CONTEXT', shortLabel: 'Import' });
  expect((await request('FindManyCommandMenuItems')).data.commandMenuItems).toHaveLength(commands.length);
});
