import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { crmPermissions, crmRecords } from '../src/crm-records';
import type { Env } from '../src/types';

let db: DatabaseSync;
let env: Env;
const now = '2026-09-17T12:00:00.000Z';
const companyId = 'd6950e90-9eb9-48f6-8540-052a20c5d019';
const personId = 'c13ef4fc-4f58-4087-9e51-61767b8c19fb';
const opportunityId = 'daafc9b8-77fc-4ebc-9c09-c084bd85ad77';
const activityId = '8e61c464-bce2-476a-bd53-99cd68d45a34';
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run('alpha', 'Alpha', now);
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run('beta', 'Beta', now);
  const prepare = (sql: string) => ({ bind(...values: unknown[]) {
    const statement = db.prepare(sql);
    return { first: async () => statement.get(...values as never[]) ?? null, all: async () => ({results: statement.all(...values as never[])}), run: async () => ({ success: true, meta: statement.run(...values as never[]) }) };
  } });
  env = { CRM_DB: { prepare, batch: async (statements: {run: () => Promise<unknown>}[]) => {
    db.exec('BEGIN');
    try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); return results; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  } } } as unknown as Env;
});
afterEach(() => db.close());
const roots: Record<string, string> = {FindOnePerson:'person',FindOneCompany:'company',FindOneOpportunity:'opportunity',FindOneActivity:'activity',FindOneBlocklist:'blocklist',FindManyPeople:'people',FindManyCompanies:'companies',FindManyOpportunities:'opportunities',FindManyActivities:'activities',FindManyBlocklists:'blocklists',AggregatePeople:'people',AggregateCompanies:'companies',AggregateOpportunities:'opportunities',AggregateActivities:'activities',AggregateBlocklists:'blocklists'};
const request = async (op: string, vars: Record<string, unknown> = {}, role = 'owner', workspace = 'alpha', query?: string) => {
  const root = roots[op] ?? op.replace(/One|Many/, '').replace(/^./, letter => letter.toLowerCase());
  const response = (await crmRecords(op, query ?? `${/^(Find|Aggregate)/.test(op) ? 'query' : 'mutation'} ${op} { ${root} { ${op.startsWith('Aggregate') ? 'totalCount' : 'id'} __typename } }`, vars, env, workspace, role, 'user:test'))!;
  return { status: response.status, body: await response.json() as any };
};
const createCompany = (id = companyId, name = 'Example company') => request('CreateOneCompany', { input: { id, name, domain: 'example.invalid' } });

it('supports the upstream workspace blocklist settings workflow', async () => {
  // Stable IDs preserve the API's documented id-ascending tie-break when two
  // records share the same millisecond-level createdAt value in SQLite.
  const firstId='00000000-0000-4000-8000-000000000002',secondId='00000000-0000-4000-8000-000000000001';
  const created=await request('CreateManyBlocklists',{input:[{id:firstId,handle:'blocked@example.invalid',scope:'WORKSPACE'},{id:secondId,handle:'@example.invalid',scope:'WORKSPACE'}]});
  expect(created.status).toBe(200);
  expect(created.body.data.createBlocklists).toHaveLength(2);
  const listed=await request('FindManyBlocklists',{filter:{scope:{eq:'WORKSPACE'}},orderBy:[{createdAt:'DescNullsLast'}]});
  expect(listed.body.data.blocklists.nodes.map((entry:any)=>entry.handle)).toEqual(['@example.invalid','blocked@example.invalid']);
  expect(listed.body.data.blocklists.nodes.every((entry:any)=>Number.isFinite(Date.parse(entry.createdAt)))).toBe(true);
  expect((await request('DeleteOneBlocklist',{idToDelete:firstId})).status).toBe(200);
  expect((await request('FindManyBlocklists',{filter:{scope:{eq:'WORKSPACE'}}})).body.data.blocklists.totalCount).toBe(1);
});

it('creates a client UUID instead of falsely updating and persists the generated Twenty full-name contract', async () => {
  const response = await request('CreateOnePerson', { input: { id: personId, name: {firstName: 'Ana', lastName: 'Vega'}, email: 'ana@example.invalid' } });
  expect(response.status).toBe(200);
  expect(response.body.data.createPerson).toMatchObject({__typename:'Person', id:personId, name:{firstName:'Ana',lastName:'Vega'}, email:'ana@example.invalid', deletedAt:null});
  expect(db.prepare('SELECT id,first_name,last_name,owner_subject FROM contacts').get()).toMatchObject({id:personId,first_name:'Ana',last_name:'Vega',owner_subject:'user:test'});
  const detail = await request('FindOnePerson', {objectRecordId:personId});
  expect(detail.body.data.person.name).toEqual({__typename:'FullName',firstName:'Ana',lastName:'Vega'});
  expect((await request('UpdateOnePerson', {idToUpdate:personId,input:{name:{lastName:'Ruiz'}}})).body.data.updatePerson.name).toMatchObject({firstName:'Ana',lastName:'Ruiz'});
});

it('persists a complete company/person/opportunity/activity journey and returns linked records', async () => {
  expect((await createCompany()).status).toBe(200);
  await request('CreateOnePerson', {input:{id:personId,name:{firstName:'Ana',lastName:'Vega'}}});
  const deal = await request('CreateOneOpportunity', {input:{id:opportunityId,name:'Sample contract', amount:1234.56, stage:'qualified', companyId, pointOfContactId:personId}});
  expect(deal.status).toBe(200);
  expect(deal.body.data.createOpportunity).toMatchObject({amount:1234.56,company:{id:companyId,__typename:'Company'},pointOfContact:{id:personId,name:{firstName:'Ana'}}});
  expect(db.prepare('SELECT amount_cents FROM opportunities').get()).toMatchObject({amount_cents:123456});
  const activity = await request('CreateOneActivity', {input:{id:activityId,title:'Call Ana',type:'call',body:'Discuss the sample proposal',contactId:personId,companyId,opportunityId,dueAt:now}});
  expect(activity.status).toBe(200);
  expect(activity.body.data.createActivity).toMatchObject({contact:{id:personId},company:{id:companyId},opportunity:{id:opportunityId},dueAt:now});
  const company = await request('FindOneCompany',{objectRecordId:companyId});
  expect(company.body.data.company.opportunities.edges[0].node.id).toBe(opportunityId);
  expect(company.body.data.company.activities.totalCount).toBe(1);
  const update = await request('UpdateOneActivity',{idToUpdate:activityId,input:{completedAt:now,company:{disconnect:true}}});
  expect(update.body.data.updateActivity.completedAt).toBe(now);
  expect(update.body.data.updateActivity.company).toBeNull();
});

it('never reads, updates, deletes or links another workspace record', async () => {
  await request('CreateOneCompany',{input:{id:companyId,name:'Private'}},'owner','beta');
  expect((await request('FindOneCompany',{objectRecordId:companyId})).body.data.company).toBeNull();
  expect((await request('FindManyCompanies')).body.data.companies.totalCount).toBe(0);
  expect((await request('UpdateOneCompany',{idToUpdate:companyId,input:{name:'stolen'}})).status).toBe(404);
  expect((await request('DeleteOneCompany',{idToDelete:companyId})).status).toBe(404);
  expect((await request('CreateOneOpportunity',{input:{id:opportunityId,name:'Bad link',companyId}})).status).toBe(400);
  expect(db.prepare('SELECT name FROM companies WHERE id = ?').get(companyId)).toMatchObject({name:'Private'});
  expect(db.prepare('SELECT * FROM opportunities').all()).toEqual([]);
});

it('atomically rejects a duplicate create without changing existing records or committing the other batch rows', async () => {
  await createCompany();
  const duplicate = await createCompany(companyId, 'Overwritten');
  expect(duplicate.status).toBe(409);
  const batch = await request('CreateManyCompanies',{input:[{id:crypto.randomUUID(),name:'Would roll back'},{id:companyId,name:'Duplicate'}]});
  expect(batch.status).toBe(409);
  expect(db.prepare('SELECT name FROM companies').all()).toEqual([{name:'Example company'}]);
});

it('rechecks relationship ownership atomically if a target is removed between validation and commit', async () => {
  await createCompany();
  const batch = env.CRM_DB!.batch.bind(env.CRM_DB);
  env.CRM_DB!.batch = async statements => {
    db.prepare('UPDATE companies SET deleted_at = ? WHERE id = ?').run(now,companyId);
    return batch(statements);
  };
  const response = await request('CreateManyOpportunities',{input:[{id:crypto.randomUUID(),name:'Would roll back'},{id:opportunityId,name:'Raced',companyId}]});
  expect(response.status).toBe(409);
  expect(db.prepare('SELECT * FROM opportunities').all()).toEqual([]);
});

it('supports generated filter groups, full-name filtering and orderBy arrays with exact totalCount/cursors', async () => {
  for (const [firstName,lastName] of [['Ana','Zeta'],['Bea','Vega'],['Cora','Vega'],['Dora','Adams']]) await request('CreateOnePerson',{input:{id:crypto.randomUUID(),name:{firstName,lastName}}});
  const vars = {filter:{and:[{name:{lastName:{eq:'Vega'}}},{or:[{name:{firstName:{ilike:'B%'}}},{name:{firstName:{eq:'Cora'}}}]}]},orderBy:[{name:{firstName:'ASC'}}],limit:1};
  const generatedQuery = 'query FindManyPeople($filter: PersonFilterInput, $orderBy: [PersonOrderByInput], $lastCursor: String, $limit: Int, $offset: Int) { people(filter: $filter, orderBy: $orderBy, first: $limit, after: $lastCursor, offset: $offset) { edges { node { id name { firstName lastName } __typename } cursor } pageInfo { hasNextPage hasPreviousPage startCursor endCursor } totalCount } }';
  const first = (await request('FindManyPeople',vars,'owner','alpha',generatedQuery)).body.data.people;
  expect(first.totalCount).toBe(2); expect(first.edges[0].node.name.firstName).toBe('Bea'); expect(first.pageInfo.hasNextPage).toBe(true);
  const second = (await request('FindManyPeople',{...vars,lastCursor:first.pageInfo.endCursor},'owner','alpha',generatedQuery)).body.data.people;
  expect(second.totalCount).toBe(2); expect(second.edges[0].node.name.firstName).toBe('Cora'); expect(second.pageInfo.hasNextPage).toBe(false); expect(second.pageInfo.hasPreviousPage).toBe(true);
  const backward = (await request('FindManyPeople',{...vars,lastCursor:second.pageInfo.startCursor},'owner','alpha','query FindManyPeople($lastCursor: String) { people(last: $limit, before: $lastCursor) { edges { node { id } } }')).body.data.people;
  expect(backward.edges[0].node.name.firstName).toBe('Bea');
  expect((await request('AggregatePeople',{filter:vars.filter})).body).toEqual({data:{people:{__typename:'PersonConnection',totalCount:2}}});
});

it.each([{filter:{secret:{eq:'value'}}},{filter:{name:{unsafe:'x'}}},{orderBy:[{name:'DROP TABLE companies'}]},{orderBy:'name'},{limit:101},{after:'not-a-cursor'},{filter:{and:'not-an-array'}}])('rejects invalid filtering/sorting/pagination explicitly: %j', async vars => {
  expect((await request('FindManyCompanies',vars)).status).toBe(400);
});

it('accepts the actual generated name-sort payload using PascalCase direction enums', async () => {
  for(const [firstName,lastName] of [['Zoe','Vega'],['Ana','Zeta'],['Ana','Adams']]) await request('CreateOnePerson',{input:{id:crypto.randomUUID(),name:{firstName,lastName}}});
  const response=await request('FindManyPeople',{filter:{},limit:60,orderBy:[{name:{firstName:'AscNullsLast'}},{name:{lastName:'AscNullsLast'}}]});
  expect(response.status).toBe(200);
  expect(response.body.data.people.nodes.map((person:any)=>`${person.name.firstName} ${person.name.lastName}`)).toEqual(['Ana Adams','Ana Zeta','Zoe Vega']);
});

it.each([
  ['AscNullsFirst',[null,'a.example','z.example']],
  ['AscNullsLast',['a.example','z.example',null]],
  ['DescNullsFirst',[null,'z.example','a.example']],
  ['DescNullsLast',['z.example','a.example',null]],
])('implements upstream %s null ordering with an explicit enum whitelist', async (direction, expected) => {
  for(const domain of ['z.example',null,'a.example']) await request('CreateOneCompany',{input:{id:crypto.randomUUID(),name:'Sort sample',domain}});
  const response=await request('FindManyCompanies',{orderBy:[{domain:direction}]});
  expect(response.status).toBe(200);
  expect(response.body.data.companies.nodes.map((company:any)=>company.domain)).toEqual(expected);
  expect((await request('FindManyCompanies',{orderBy:[{domain:'AscNullsLast; DROP TABLE companies'}]})).status).toBe(400);
  expect((await request('FindManyCompanies',{orderBy:[{domain:'__proto__'}]})).status).toBe(400);
});

it('soft-deletes, lists trash, restores, then explicitly destroys while preserving live records', async () => {
  await createCompany();
  const liveId=crypto.randomUUID(); await createCompany(liveId,'Keep me');
  const deleted = await request('DeleteOneCompany',{idToDelete:companyId});
  expect(deleted.body.data.deleteCompany.deletedAt).toEqual(expect.any(String));
  expect((await request('FindOneCompany',{objectRecordId:companyId})).body.data.company).toBeNull();
  expect((await request('FindManyCompanies')).body.data.companies.totalCount).toBe(1);
  const trash=(await request('FindManyCompanies',{filter:{deletedAt:{is:'NOT_NULL'}}})).body.data.companies;
  expect(trash.totalCount).toBe(1); expect(trash.nodes[0].id).toBe(companyId);
  expect((await request('RestoreManyCompanies',{filter:{id:{in:[companyId]}}})).body.data.restoreCompanies[0].deletedAt).toBeNull();
  expect((await request('FindManyCompanies')).body.data.companies.totalCount).toBe(2);
  expect((await request('DestroyOneCompany',{idToDestroy:companyId})).status).toBe(400);
  expect((await request('DestroyManyCompanies',{filter:{deletedAt:{is:'NULL'}}})).body.data.destroyCompanies).toEqual([]);
  await request('DeleteManyCompanies',{filter:{id:{eq:companyId}}});
  expect((await request('DestroyManyCompanies',{filter:{id:{eq:companyId}}})).status).toBe(200);
  expect(db.prepare('SELECT id FROM companies').all()).toEqual([{id:liveId}]);
});

it('computes real footer aggregates using Twenty numeric and empty-value contracts', async () => {
  for (const amount of [null,12.34,45.67]) await request('CreateOneOpportunity',{input:{name:'Amount sample',amount}});
  const response = await request('AggregateOpportunities',{},'owner','alpha','query AggregateOpportunities($filter: OpportunityFilterInput) { opportunities(filter: $filter) { totalCount sumAmount avgAmount minAmount maxAmount countEmptyAmount percentageNotEmptyAmount __typename } }');
  expect(response.status).toBe(200);
  expect(response.body.data.opportunities).toMatchObject({totalCount:3,sumAmount:58.01,avgAmount:29.005,minAmount:12.34,maxAmount:45.67,countEmptyAmount:1,percentageNotEmptyAmount:2/3});
  expect((await request('AggregateOpportunities',{},'owner','alpha','query AggregateOpportunities { opportunities { unsupportedMetric } }')).status).toBe(400);
});

it('honors trusted role permissions and stored denials instead of accepting input roles', async () => {
  await createCompany();
  expect((await request('DeleteOneCompany',{idToDelete:companyId,role:'owner'},'member')).status).toBe(403);
  expect((await request('UpdateOneCompany',{idToUpdate:companyId,input:{name:'Member update'}},'member')).status).toBe(200);
  db.prepare('INSERT INTO workspace_settings VALUES (?, ?, ?, ?, ?)').run('alpha','permissions',JSON.stringify({owner:{read:true,create:false,update:false,delete:false},member:{read:false,create:false,update:false,delete:false}}),now,'user:test');
  expect((await createCompany(crypto.randomUUID())).status).toBe(403);
  expect((await request('FindManyCompanies',{},'member')).status).toBe(403);
  expect(await crmPermissions(env,'alpha','owner')).toEqual({read:true,create:false,update:false,delete:false});
  db.prepare('UPDATE workspace_settings SET value_json = ?').run('not json');
  expect((await request('FindManyCompanies')).status).toBe(403);
});

it('persists validated custom fields, filters/sorts them and rejects unknown or wrong typed fields', async () => {
  db.prepare('INSERT INTO custom_fields (id,workspace_id,object_type,field_key,label,field_type,created_at) VALUES (?,?,?,?,?,?,?)').run(crypto.randomUUID(),'alpha','company','priority','Priority','number',now);
  const result=await request('CreateOneCompany',{input:{id:companyId,name:'Custom',priority:3}});
  expect(result.body.data.createCompany.priority).toBe(3);
  expect((await request('FindManyCompanies',{filter:{priority:{gte:2}},orderBy:[{priority:'DESC'}]})).body.data.companies.totalCount).toBe(1);
  expect((await request('UpdateOneCompany',{idToUpdate:companyId,input:{priority:5}})).body.data.updateCompany.priority).toBe(5);
  expect((await request('UpdateOneCompany',{idToUpdate:companyId,input:{priority:'bad'}})).status).toBe(400);
  expect((await request('UpdateOneCompany',{idToUpdate:companyId,input:{undocumented:'bad'}})).status).toBe(400);
});

it('returns explicit null for absent or cleared nullable custom fields and preserves boolean values', async () => {
  const insert = db.prepare('INSERT INTO custom_fields (id,workspace_id,object_type,field_key,label,field_type,created_at) VALUES (?,?,?,?,?,?,?)');
  insert.run(crypto.randomUUID(),'alpha','company','priority','Priority','number',now);
  insert.run(crypto.randomUUID(),'alpha','company','verified','Verified','boolean',now);
  const created=await createCompany();
  expect(created.body.data.createCompany).toMatchObject({priority:null,verified:null});
  const updated=await request('UpdateOneCompany',{idToUpdate:companyId,input:{priority:3,verified:false}});
  expect(updated.body.data.updateCompany).toMatchObject({priority:3,verified:false});
  expect((await request('UpdateOneCompany',{idToUpdate:companyId,input:{priority:null}})).body.data.updateCompany.priority).toBeNull();
  const opportunity=await request('CreateOneOpportunity',{input:{name:'Linked custom fields',companyId}});
  expect(opportunity.body.data.createOpportunity.company).toMatchObject({priority:null,verified:false});
});

it('matches only explicit operation/root pairs and supports response aliases', async () => {
  expect(await crmRecords('GetCurrentUser','query GetCurrentUser { currentUser {id} }',{},env,'alpha','owner','user:test')).toBeNull();
  expect((await request('DeleteOneCompany',{idToDelete:companyId},'owner','alpha','mutation DeleteOneCompany { createPerson { id } }')).status).toBe(400);
  await createCompany();
  const alias=await request('FindManyCompanies',{},'owner','alpha','query FindManyCompanies { result: companies { edges {node {id}} } }');
  expect(alias.body.data.result.totalCount).toBe(1);
});

it('creates a blank row with server defaults and refuses silently ignored protected fields', async () => {
  const response=await request('CreateOneActivity',{input:{id:activityId}});
  expect(response.body.data.createActivity).toMatchObject({id:activityId,type:'task',title:''});
  expect((await request('UpdateOneActivity',{idToUpdate:activityId,input:{workspaceId:'beta'}})).status).toBe(400);
});

it.each(['Destroy','Delete','Restore','Update'])('rechecks lifecycle at the final %sMany write after a concurrent transition', async action => {
  await createCompany();
  const initiallyDeleted = action === 'Destroy' || action === 'Restore';
  if (initiallyDeleted) db.prepare('UPDATE companies SET deleted_at = ? WHERE id = ?').run(now,companyId);
  const prepare = env.CRM_DB!.prepare.bind(env.CRM_DB);
  let transitioned = false;
  env.CRM_DB!.prepare = ((sql: string) => {
    const statement = prepare(sql);
    const bind = statement.bind.bind(statement);
    statement.bind = (...values: unknown[]) => {
      const bound = bind(...values);
      const all = bound.all.bind(bound);
      bound.all = async () => {
        if (!transitioned && /^(UPDATE|DELETE FROM) companies/.test(sql)) {
          transitioned = true;
          db.prepare('UPDATE companies SET deleted_at = ?, updated_at = ? WHERE id = ?').run(initiallyDeleted ? null : '2026-09-17T12:05:00.000Z','2026-09-17T12:05:00.000Z',companyId);
        }
        return all();
      };
      return bound;
    };
    return statement;
  }) as typeof env.CRM_DB.prepare;
  const result=await request(`${action}ManyCompanies`,{filter:{id:{eq:companyId}},data:{name:'Must not overwrite'}});
  expect(transitioned).toBe(true);
  expect(result.status).toBe(200);
  expect(result.body.data[`${action.toLowerCase()}Companies`]).toEqual([]);
  expect(db.prepare('SELECT name,deleted_at,updated_at FROM companies WHERE id = ?').get(companyId)).toEqual({name:'Example company',deleted_at:initiallyDeleted ? null : '2026-09-17T12:05:00.000Z',updated_at:'2026-09-17T12:05:00.000Z'});
});

it('returns a conflict rather than falsely claiming a concurrently restored single record was destroyed', async () => {
  await createCompany();
  await request('DeleteOneCompany',{idToDelete:companyId});
  const prepare = env.CRM_DB!.prepare.bind(env.CRM_DB);
  env.CRM_DB!.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (!sql.startsWith('DELETE FROM companies')) return statement;
    const bind = statement.bind.bind(statement);
    statement.bind = (...values: unknown[]) => {
      const bound = bind(...values);
      const all = bound.all.bind(bound);
      bound.all = async () => {
        db.prepare('UPDATE companies SET deleted_at = NULL WHERE id = ?').run(companyId);
        return all();
      };
      return bound;
    };
    return statement;
  }) as typeof env.CRM_DB.prepare;
  expect((await request('DestroyOneCompany',{idToDestroy:companyId})).status).toBe(409);
  expect(db.prepare('SELECT deleted_at FROM companies WHERE id = ?').get(companyId)).toEqual({deleted_at:null});
});
