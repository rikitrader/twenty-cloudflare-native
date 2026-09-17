import { readFileSync,readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { handleGraphql } from '../src/graphql-compat';
import type { Env } from '../src/types';

let db:DatabaseSync;let env:Env;const workspace='b8793798-7dde-4b4a-830b-f24307c8d4f5',user='ab6d9116-4a20-4e02-bfd2-cb8c6af9231b',session='workflow-editor-session',now='2026-09-17T12:00:00.000Z';
beforeEach(()=>{
  db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort())db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  const prepare=(sql:string)=>({bind(...values:unknown[]){const statement=db.prepare(sql);return{first:async()=>statement.get(...values as never[])??null,all:async()=>({results:statement.all(...values as never[])}),run:async()=>({success:true,meta:statement.run(...values as never[])})};}});
  env={ACCESS_REQUIRED:'true',CRM_DB:{prepare,batch:async(statements:{run:()=>Promise<unknown>}[])=>{db.exec('BEGIN');try{const output=[];for(const statement of statements)output.push(await statement.run());db.exec('COMMIT');return output;}catch(error){db.exec('ROLLBACK');throw error;}}},JOBS_QUEUE:{send:vi.fn()}} as unknown as Env;
  db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run(workspace,'Workflow test',now);db.prepare('INSERT INTO native_users (id,email,password_hash,password_salt,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(user,'workflow@example.invalid','x','x',now,now);db.prepare("INSERT INTO workspace_members VALUES (?,?,'owner','active',?)").run(workspace,`user:${user}`,now);db.prepare('INSERT INTO native_sessions VALUES (?,?,?,?,?,?,NULL)').run(session,workspace,`user:${user}`,now,now,'2099-01-01T00:00:00.000Z');
});
afterEach(()=>db.close());
async function post(operationName:string,root:string,variables:Record<string,unknown>={}){const response=(await handleGraphql(new Request('https://crm.test/graphql',{method:'POST',headers:{'content-type':'application/json',cookie:`twenty_session=${session}`,'x-workspace-id':workspace},body:JSON.stringify({operationName,query:`mutation ${operationName} { ${root} { id } }`,variables})}),env))!;return{status:response.status,body:await response.json() as Record<string,any>};}

it('edits a draft graph and freezes an immutable published snapshot',async()=>{
  const created=await post('CreateCoreWorkflow','createCoreWorkflow',{input:{name:'Review lead'}});expect(created.status).toBe(200);const workflowId=created.body.data.createCoreWorkflow.id;const draft=db.prepare("SELECT id FROM native_workflow_versions WHERE workflow_id=? AND status='DRAFT'").get(workflowId) as {id:string};
  expect((await post('UpdateWorkflowVersionTrigger','updateWorkflowVersionTrigger',{input:{workflowVersionId:draft.id,trigger:{type:'MANUAL',settings:{}}}})).status).toBe(200);
  const first=crypto.randomUUID(),second=crypto.randomUUID();expect((await post('CreateWorkflowVersionStep','createWorkflowVersionStep',{input:{workflowVersionId:draft.id,id:first,stepType:'CREATE_RECORD',position:{x:10,y:20},defaultSettings:{name:'Create company'}}})).status).toBe(200);await post('CreateWorkflowVersionStep','createWorkflowVersionStep',{input:{workflowVersionId:draft.id,id:second,stepType:'SEND_EMAIL',position:{x:40,y:20}}});
  expect((await post('CreateWorkflowVersionEdge','createWorkflowVersionEdge',{input:{workflowVersionId:draft.id,source:first,target:second}})).status).toBe(200);expect((await post('UpdateWorkflowVersionPositions','updateWorkflowVersionPositions',{input:{workflowVersionId:draft.id,positions:[{id:second,position:{x:80,y:100}}]}})).body.data.updateWorkflowVersionPositions).toBe(true);
  expect((await post('ActivateWorkflowVersion','activateWorkflowVersion',{workflowVersionId:draft.id})).body.data.activateWorkflowVersion).toBe(true);const published=db.prepare('SELECT w.definition_json,v.snapshot_hash,v.status AS status FROM native_workflows w JOIN native_workflow_versions v ON v.id=? WHERE w.id=?').get(draft.id,workflowId) as Record<string,string>;expect(published.status).toBe('ACTIVE');expect(published.snapshot_hash).toMatch(/^[0-9a-f]{64}$/);
  expect((await post('UpdateWorkflowVersionStep','updateWorkflowVersionStep',{input:{workflowVersionId:draft.id,step:{id:first,name:'Changed'}}})).status).toBe(409);
  const copied=await post('CreateDraftFromWorkflowVersion','createDraftFromWorkflowVersion',{input:{workflowId,workflowVersionIdToCopy:draft.id}});expect(copied.status).toBe(200);const newDraft=copied.body.data.createDraftFromWorkflowVersion.id;await post('UpdateWorkflowVersionStep','updateWorkflowVersionStep',{input:{workflowVersionId:newDraft,step:{id:first,name:'Changed draft'}}});
  expect((db.prepare('SELECT definition_json FROM native_workflows WHERE id=?').get(workflowId) as {definition_json:string}).definition_json).toBe(published.definition_json);
  const content=await post('GetWorkflowVersionContent','workflowVersionContent',{workflowVersionId:newDraft});expect(content.body.data.workflowVersionContent.steps.find((step:Record<string,unknown>)=>step.id===first).name).toBe('Changed draft');
});

it('archives workflows instead of destructively deleting version history',async()=>{const created=await post('CreateCoreWorkflow','createCoreWorkflow',{input:{name:'Archive me'}});const workflowId=created.body.data.createCoreWorkflow.id;const removed=await post('DeleteCoreWorkflows','deleteCoreWorkflows',{workflowId});expect(removed.status).toBe(200);expect(db.prepare('SELECT status FROM native_workflows WHERE id=?').get(workflowId)).toMatchObject({status:'archived'});expect(db.prepare('SELECT status FROM native_workflow_versions WHERE workflow_id=?').get(workflowId)).toMatchObject({status:'ARCHIVED'});});
