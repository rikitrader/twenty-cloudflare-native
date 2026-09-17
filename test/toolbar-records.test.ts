import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { toolbarRecords } from '../src/toolbar-records';
import { crmMetadata, crmNavigation } from '../src/crm-metadata';
import type { Env } from '../src/types';

let db: DatabaseSync;
let env: Env;
const now='2026-09-17T12:00:00.000Z';
const workflowId='9018e8d2-f23d-4a33-9e77-b61e5a6f2df2';
beforeEach(() => {
  db=new DatabaseSync(':memory:');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run('alpha','Alpha',now);
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run('beta','Beta',now);
  const prepare=(sql:string)=>({bind:(...values:unknown[])=>({
    first:async()=>db.prepare(sql).get(...values as never[])??null,
    all:async()=>({results:db.prepare(sql).all(...values as never[])}),
    run:async()=>({meta:db.prepare(sql).run(...values as never[])}),
  })});
  env={CRM_DB:{prepare}} as unknown as Env;
});
afterEach(()=>db.close());
const insert=(id=workflowId,workspace='alpha',status='active',definition:unknown={trigger:{type:'MANUAL'},steps:[{id:'step-a',type:'FILTER'}]})=>db.prepare('INSERT INTO native_workflows (id,workspace_id,name,description,status,definition_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id,workspace,'Stored native workflow','Existing definition',status,JSON.stringify(definition),'user:owner',now,now);
const read=async(op:string,variables:Record<string,unknown>={},workspace='alpha',role='owner')=>{
  const root=op==='GetWorkflowVersionContent'?'workflowVersionContent':op==='FindOneWorkflow'?'workflow':op==='FindOneWorkflowVersion'?'workflowVersion':op.endsWith('Versions')?'workflowVersions':'workflows';
  const response=(await toolbarRecords(op,`query ${op} { ${root} { id __typename } }`,variables,env,workspace,role))!;
  return {status:response.status,body:await response.json() as any};
};

it('supplies hidden read-only workflow metadata required by the command toolbar without enabling workflow navigation',async()=>{
  const objects=await crmMetadata(env,'alpha');
  for(const name of ['workflow','workflowVersion']) {
    const metadata=objects.find(object=>object.nameSingular===name)!;
    expect(metadata).toMatchObject({isSystem:true,isUICreatable:false,isUIEditable:false,writability:'SYSTEM'});
    expect(metadata.fieldsList.every((field:any)=>field.writability==='SYSTEM')).toBe(true);
  }
  const navigation=await crmNavigation(env,'alpha',objects);
  expect(navigation.map(item=>item.name)).toEqual(['People','Companies','Opportunities','Activities']);
});

it('returns the persisted native workflow current definition rather than empty placeholder results',async()=>{
  insert();
  const one=await read('FindOneWorkflowVersion',{objectRecordId:workflowId});
  expect(one.status).toBe(200);
  expect(one.body.data.workflowVersion).toMatchObject({__typename:'WorkflowVersion',id:workflowId,workflowId,status:'ACTIVE',name:'Stored native workflow',trigger:{type:'MANUAL'},steps:[{id:'step-a',type:'FILTER'}]});
  const list=await read('FindManyWorkflowVersions',{filter:{workflowId:{eq:workflowId},status:{eq:'ACTIVE'}},limit:10});
  expect(list.body.data.workflowVersions.totalCount).toBe(1);
  expect(list.body.data.workflowVersions.edges[0].node.id).toBe(workflowId);
  const content=await read('GetWorkflowVersionContent',{workflowVersionId:workflowId});
  expect(content.body.data.workflowVersionContent).toEqual({__typename:'WorkflowVersionContent',workflowVersionId:workflowId,trigger:{type:'MANUAL'},steps:[{id:'step-a',type:'FILTER'}]});
  const workflows=await read('FindManyWorkflows',{filter:{id:{in:[workflowId]}}});
  expect(workflows.body.data.workflows.nodes[0]).toMatchObject({id:workflowId,lastPublishedVersionId:workflowId,statuses:['ACTIVE'],versions:{totalCount:1,edges:[{node:{id:workflowId,status:'ACTIVE'}}]}});
});

it('preserves tenant boundaries and stored read-denial policies',async()=>{
  insert();
  expect((await read('FindOneWorkflowVersion',{objectRecordId:workflowId},'beta')).body.data.workflowVersion).toBeNull();
  expect((await read('FindManyWorkflowVersions',{},'beta')).body.data.workflowVersions.totalCount).toBe(0);
  expect((await read('GetWorkflowVersionContent',{workflowVersionId:workflowId},'beta')).body.data.workflowVersionContent).toBeNull();
  db.prepare('INSERT INTO workspace_settings VALUES (?,?,?,?,?)').run('alpha','permissions',JSON.stringify({member:{read:false}}),now,'owner');
  expect((await read('FindManyWorkflowVersions',{},'alpha','member')).status).toBe(403);
});

it('supports actual toolbar ID lists and cursor pagination without hiding saved definitions',async()=>{
  insert(); const second=crypto.randomUUID(); insert(second,'alpha','draft');
  const first=(await read('FindManyWorkflowVersions',{filter:{id:{in:[workflowId,second]}},orderBy:[{name:'ASC'}],limit:1})).body.data.workflowVersions;
  expect(first.totalCount).toBe(2); expect(first.pageInfo.hasNextPage).toBe(true);
  const next=(await read('FindManyWorkflowVersions',{filter:{id:{in:[workflowId,second]}},orderBy:[{name:'ASC'}],limit:1,lastCursor:first.pageInfo.endCursor})).body.data.workflowVersions;
  expect(next.nodes).toHaveLength(1); expect(next.nodes[0].id).not.toBe(first.nodes[0].id); expect(next.pageInfo.hasNextPage).toBe(false);
});

it('does not fabricate version history and rejects unsupported writes explicitly',async()=>{
  insert();
  const response=(await toolbarRecords('CreateOneWorkflowVersion','mutation CreateOneWorkflowVersion { createWorkflowVersion {id} }',{input:{name:'Unimplemented'}},env,'alpha','owner'))!;
  expect(response.status).toBe(501);
  expect(db.prepare('SELECT COUNT(*) AS count FROM native_workflows').get()).toEqual({count:1});
  const current=(await read('FindOneWorkflow',{objectRecordId:workflowId})).body.data.workflow;
  expect(current.versions.totalCount).toBe(1);
  expect(await toolbarRecords('CreateOnePerson','',{},env,'alpha','owner')).toBeNull();
});

it('rejects unknown filters and malformed persisted definitions instead of claiming successful empty reads',async()=>{
  insert();
  expect((await read('FindManyWorkflowVersions',{filter:{secret:{eq:'x'}}})).status).toBe(400);
  db.prepare('UPDATE native_workflows SET definition_json = ?').run('broken json');
  expect((await read('FindOneWorkflowVersion',{objectRecordId:workflowId})).status).toBe(400);
});

it.each(['AscNullsFirst','AscNullsLast','DescNullsFirst','DescNullsLast'])('accepts exact upstream %s sorting for toolbar workflow reads',async direction=>{
  insert();
  expect((await read('FindManyWorkflowVersions',{orderBy:[{name:direction}]})).status).toBe(200);
  expect((await read('FindManyWorkflowVersions',{orderBy:[{name:`${direction}; DROP TABLE native_workflows`}]})).status).toBe(400);
});
