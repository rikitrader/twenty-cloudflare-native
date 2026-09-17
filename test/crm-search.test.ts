import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { afterEach,beforeEach,expect,it } from 'vitest';
import { crmSearch } from '../src/crm-search';
import type { Env } from '../src/types';
// @ts-expect-error Shared operator fixture script.
import { seedSql } from '../scripts/seed-crm-sample.mjs';
let db:DatabaseSync; let env:Env;
const workspace='75c22091-10d6-4791-bd04-43ffd8ef0926';
const subject='user:11111111-1111-4111-8111-111111111111';
beforeEach(()=>{
  db=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run(workspace,'Test','2026-09-17');
  db.prepare("INSERT INTO workspace_members VALUES (?,?,'owner','active',?)").run(workspace,subject,'2026-09-17');
  db.exec(seedSql(workspace,subject));
  env={CRM_DB:{prepare:(sql:string)=>({bind:(...values:any[])=>({first:async()=>db.prepare(sql).get(...values)??null,all:async()=>({results:db.prepare(sql).all(...values)})})})}} as unknown as Env;
});
afterEach(()=>db.close());
it('returns real search edges and stable continuation without duplicating records',async()=>{
  const run=async(vars:any)=>{const r=(await crmSearch('Search','query Search { search { edges { node { recordId } } } }',vars,env,workspace,'owner',subject))!;expect(r.status).toBe(200);return await r.json() as any;};
  const first=await run({searchInput:'DEMO',limit:3});
  expect(first.data.search.edges).toHaveLength(3);
  expect(first.data.search.pageInfo.hasNextPage).toBe(true);
  const next=await run({searchInput:'DEMO',limit:3,after:first.data.search.pageInfo.endCursor});
  expect(new Set([...first.data.search.edges,...next.data.search.edges].map((edge:any)=>edge.node.recordId)).size).toBe(6);
  const companies=await run({searchInput:'DEMO',limit:100,includedObjectNameSingulars:['company']});
  expect(companies.data.search.edges).toHaveLength(3);
  expect(companies.data.search.edges[0].node.objectNameSingular).toBe('company');
});
it('does not return another tenant or bypass a stored read denial',async()=>{
  const result=(await crmSearch('Search','',{searchInput:'DEMO',limit:10},env,'another-workspace','owner',subject))!;
  expect((await result.json() as any).data.search.edges).toEqual([]);
  db.prepare('INSERT INTO workspace_settings VALUES (?,?,?,?,?)').run(workspace,'permissions',JSON.stringify({member:{read:false}}),'2026-09-17',subject);
  expect((await crmSearch('Search','',{searchInput:'DEMO',limit:10},env,workspace,'member',subject))!.status).toBe(403);
});
it('maps combined relation-picker queries to tenant-scoped core connections',async()=>{
  const result=(await crmSearch('CombinedFindManyRecords','query CombinedFindManyRecords { companies(filter:$filterCompany) {edges{node{id}}} people(filter:$filterPerson){edges{node{id}}}}',
    {firstCompany:2,firstPerson:2,filterCompany:{name:{ilike:'%Aurora%'}}},env,workspace,'owner',subject))!;
  const body=await result.json() as any;
  expect(result.status).toBe(200);
  expect(body.data.companies.edges).toHaveLength(1);
  expect(body.data.companies.edges[0].node.name).toBe('DEMO · Aurora Labs');
  expect(body.data.people.edges).toHaveLength(2);
});
it('rejects malformed filters, cursors and identifiers instead of ignoring them',async()=>{
  for(const input of [{after:'badcursor'},{filter:{"id; DROP TABLE companies":{eq:'x'}}},{filter:{id:{eq:42}}},{limit:101}]) {
    const response=(await crmSearch('Search','',{searchInput:'DEMO',limit:10,...input},env,workspace,'owner',subject))!;
    expect(response.status).toBe(400);
  }
});
it('paginates Unicode labels without corrupting cursor encoding or SQL ordering',async()=>{
  db.prepare('INSERT INTO companies (id,workspace_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(crypto.randomUUID(),workspace,'DEMO · Équipe 中文 🚀','2026-09-17','2026-09-17');
  db.prepare('INSERT INTO companies (id,workspace_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(crypto.randomUUID(),workspace,'DEMO · école 中文 🌟','2026-09-17','2026-09-17');
  let after=null; const labels:string[]=[];
  for(let page=0;page<6;page++) {
    const result=(await crmSearch('Search','',{searchInput:'DEMO',limit:1,includedObjectNameSingulars:['company'],after},env,workspace,'owner',subject))!;
    expect(result.status).toBe(200);
    const body=await result.json() as any;
    labels.push(...body.data.search.edges.map((edge:any)=>edge.node.label));
    if(!body.data.search.pageInfo.hasNextPage) break;
    after=body.data.search.pageInfo.endCursor;
  }
  expect(labels).toHaveLength(5);expect(new Set(labels).size).toBe(5);
  expect(labels).toContain('DEMO · Équipe 中文 🚀');
});
