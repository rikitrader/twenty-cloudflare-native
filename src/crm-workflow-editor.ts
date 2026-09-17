import type { Env } from './types';

type Row=Record<string,any>;
const object=(value:unknown):value is Row=>!!value&&typeof value==='object'&&!Array.isArray(value);
const input=(vars:Row)=>object(vars.input)?vars.input:{};
const error=(message:string,status=400)=>Response.json({errors:[{message,extensions:{code:status===403?'FORBIDDEN':'BAD_USER_INPUT'}}]},{status});
const parse=(value:unknown,fallback:any)=>{try{return typeof value==='string'?JSON.parse(value):value??fallback;}catch{return fallback;}};
const json=(value:unknown,max=200_000)=>{const encoded=JSON.stringify(value);if(encoded.length>max)throw new Error('Workflow definition is too large');return encoded;};
const admin=(role:string)=>role==='owner'||role==='admin';
const versionValue=(row:Row)=>({__typename:'WorkflowVersion',id:row.id,workflowId:row.workflow_id,workspaceWorkflowVersionId:row.id,workspaceWorkflowId:row.workflow_id,label:`Version ${row.version}`,name:`Version ${row.version}`,status:row.status,trigger:parse(row.trigger_json,null),steps:parse(row.steps_json,[]),edges:parse(row.edges_json,[]),createdAt:row.created_at,updatedAt:row.updated_at});
const diff=(before:Row,after:Row)=>({__typename:'WorkflowVersionStepChanges',triggerDiff:{before:parse(before.trigger_json,null),after:parse(after.trigger_json,null)},stepsDiff:{before:parse(before.steps_json,[]),after:parse(after.steps_json,[])}});
async function sha256(value:string){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return [...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join('');}

export async function workflowEditor(op:string,vars:Row,env:Env,workspaceId:string,role:string,actor:string):Promise<Response|null>{
  if(!/^(CreateDraftFromWorkflowVersion|CreateWorkflowVersionStep|UpdateWorkflowVersionStep|DeleteWorkflowVersionStep|DuplicateWorkflowVersionStep|CreateWorkflowVersionEdge|DeleteWorkflowVersionEdge|UpdateWorkflowVersionTrigger|UpdateWorkflowVersionPositions|ActivateWorkflowVersion|DeactivateWorkflowVersion|GetWorkflowVersionContent|GetCoreWorkflowVersion|GetCoreWorkflowVersions|DiscardCoreWorkflowDraft)$/.test(op))return null;
  if(!/^(GetWorkflowVersionContent|GetCoreWorkflowVersion|GetCoreWorkflowVersions)$/.test(op)&&!admin(role))return error('admin access required',403);
  const db=env.CRM_DB!,raw=input(vars);const versionId=String(vars.workflowVersionId??raw.workflowVersionId??'');
  if(op==='GetCoreWorkflowVersions'){
    const workflowId=String(vars.workspaceWorkflowId??'');const rows=await db.prepare('SELECT * FROM native_workflow_versions WHERE workspace_id=? AND workflow_id=? ORDER BY version DESC').bind(workspaceId,workflowId).all<Row>();return Response.json({data:{coreWorkflowVersions:rows.results.map(versionValue)}});
  }
  if(op==='GetCoreWorkflowVersion'){
    const id=String(vars.workspaceWorkflowVersionId??'');const row=await db.prepare('SELECT * FROM native_workflow_versions WHERE workspace_id=? AND id=?').bind(workspaceId,id).first<Row>();return Response.json({data:{coreWorkflowVersion:row?versionValue(row):null}});
  }
  if(op==='DiscardCoreWorkflowDraft'){
    const id=String(raw.workspaceWorkflowVersionId??'');const draft=await db.prepare("SELECT v.*,w.name FROM native_workflow_versions v JOIN native_workflows w ON w.id=v.workflow_id AND w.workspace_id=v.workspace_id WHERE v.workspace_id=? AND v.id=? AND v.status='DRAFT'").bind(workspaceId,id).first<Row>();if(!draft)return error('Draft workflow version not found',404);await db.prepare("DELETE FROM native_workflow_versions WHERE workspace_id=? AND id=? AND status='DRAFT'").bind(workspaceId,id).run();return Response.json({data:{discardCoreWorkflowDraft:{id:draft.workflow_id,workspaceWorkflowId:draft.workflow_id,name:draft.name,statuses:['DEACTIVATED'],lastPublishedVersionId:null,updatedAt:new Date().toISOString()}}});
  }
  if(op==='CreateDraftFromWorkflowVersion'){
    const sourceId=String(raw.workflowVersionIdToCopy??''),workflowId=String(raw.workflowId??'');const source=await db.prepare('SELECT v.* FROM native_workflow_versions v JOIN native_workflows w ON w.id=v.workflow_id AND w.workspace_id=v.workspace_id WHERE v.workspace_id=? AND v.id=? AND v.workflow_id=?').bind(workspaceId,sourceId,workflowId).first<Row>();if(!source)return error('Workflow version not found',404);
    const existing=await db.prepare("SELECT 1 FROM native_workflow_versions WHERE workspace_id=? AND workflow_id=? AND status='DRAFT'").bind(workspaceId,workflowId).first();if(existing)return error('A draft already exists',409);
    const max=await db.prepare('SELECT COALESCE(MAX(version),0) AS value FROM native_workflow_versions WHERE workspace_id=? AND workflow_id=?').bind(workspaceId,workflowId).first<{value:number}>();const id=crypto.randomUUID(),now=new Date().toISOString();
    await db.prepare("INSERT INTO native_workflow_versions (id,workflow_id,workspace_id,version,status,trigger_json,steps_json,edges_json,created_by,created_at,updated_at) VALUES (?,?,?,?,'DRAFT',?,?,?,?,?,?)").bind(id,workflowId,workspaceId,Number(max?.value??0)+1,source.trigger_json,source.steps_json,source.edges_json,actor,now,now).run();
    return Response.json({data:{createDraftFromWorkflowVersion:versionValue((await db.prepare('SELECT * FROM native_workflow_versions WHERE id=?').bind(id).first<Row>())!)}});
  }
  const version=await db.prepare('SELECT v.* FROM native_workflow_versions v JOIN native_workflows w ON w.id=v.workflow_id AND w.workspace_id=v.workspace_id WHERE v.workspace_id=? AND v.id=?').bind(workspaceId,versionId).first<Row>();if(!version)return error('Workflow version not found',404);
  if(op==='GetWorkflowVersionContent')return Response.json({data:{workflowVersionContent:{__typename:'WorkflowVersionContent',workflowVersionId:version.id,trigger:parse(version.trigger_json,null),steps:parse(version.steps_json,[])}}});
  if(op==='ActivateWorkflowVersion'){
    if(version.status==='ARCHIVED')return error('Archived versions cannot be activated');const snapshot=json({trigger:parse(version.trigger_json,null),steps:parse(version.steps_json,[]),edges:parse(version.edges_json,[])}),hash=await sha256(snapshot),now=new Date().toISOString();
    await db.batch([db.prepare("UPDATE native_workflow_versions SET status='DEACTIVATED',updated_at=? WHERE workspace_id=? AND workflow_id=? AND status='ACTIVE'").bind(now,workspaceId,version.workflow_id),db.prepare("UPDATE native_workflow_versions SET status='ACTIVE',snapshot_hash=?,published_at=?,updated_at=? WHERE workspace_id=? AND id=?").bind(hash,now,now,workspaceId,version.id),db.prepare("UPDATE native_workflows SET status='active',definition_json=?,updated_at=? WHERE workspace_id=? AND id=?").bind(snapshot,now,workspaceId,version.workflow_id)]);
    return Response.json({data:{activateWorkflowVersion:true}});
  }
  if(op==='DeactivateWorkflowVersion'){
    const now=new Date().toISOString();await db.batch([db.prepare("UPDATE native_workflow_versions SET status='DEACTIVATED',updated_at=? WHERE workspace_id=? AND id=? AND status='ACTIVE'").bind(now,workspaceId,version.id),db.prepare("UPDATE native_workflows SET status='inactive',updated_at=? WHERE workspace_id=? AND id=?").bind(now,workspaceId,version.workflow_id)]);return Response.json({data:{deactivateWorkflowVersion:true}});
  }
  if(version.status!=='DRAFT')return error('Published workflow versions are immutable',409);
  const before={...version};let steps=parse(version.steps_json,[]) as Row[];let edges=parse(version.edges_json,[]) as Row[];let trigger=parse(version.trigger_json,null);let result:unknown;
  if(!Array.isArray(steps)||!Array.isArray(edges))return error('Stored workflow definition is invalid',409);
  if(op==='CreateWorkflowVersionStep'){
    if(steps.length>=200)return error('Workflow step limit reached');const id=typeof raw.id==='string'?raw.id:crypto.randomUUID();if(steps.some(step=>step.id===id))return error('Step already exists',409);const step={id,name:String(raw.defaultSettings?.name??raw.stepType??'Action').slice(0,160),type:String(raw.stepType??'CODE').slice(0,80),settings:object(raw.defaultSettings)?raw.defaultSettings:{},valid:false,nextStepIds:raw.nextStepId?[String(raw.nextStepId)]:[],position:object(raw.position)?{x:Number(raw.position.x??0),y:Number(raw.position.y??0)}:{x:0,y:0}};steps.push(step);if(raw.parentStepId)edges.push({source:String(raw.parentStepId),target:id,sourceConnectionOptions:raw.parentStepConnectionOptions??null});result=null;
  }else if(op==='UpdateWorkflowVersionStep'){
    if(!object(raw.step)||typeof raw.step.id!=='string')return error('A valid step is required');const index=steps.findIndex(step=>step.id===raw.step.id);if(index<0)return error('Step not found',404);steps[index]={...steps[index],...raw.step,id:steps[index].id};result=steps[index];
  }else if(op==='DeleteWorkflowVersionStep'){
    const stepId=String(raw.stepId??'');if(!steps.some(step=>step.id===stepId))return error('Step not found',404);steps=steps.filter(step=>step.id!==stepId);edges=edges.filter(edge=>edge.source!==stepId&&edge.target!==stepId);result=null;
  }else if(op==='DuplicateWorkflowVersionStep'){
    const source=steps.find(step=>step.id===raw.stepId);if(!source)return error('Step not found',404);const duplicate=structuredClone(source);duplicate.id=crypto.randomUUID();duplicate.name=`${String(source.name??'Step')} copy`.slice(0,160);duplicate.position={x:Number(source.position?.x??0)+40,y:Number(source.position?.y??0)+40};steps.push(duplicate);result=null;
  }else if(op==='CreateWorkflowVersionEdge'||op==='DeleteWorkflowVersionEdge'){
    const source=String(raw.source??''),target=String(raw.target??'');if(!source||!target||source===target)return error('A valid edge is required');if(source!=='trigger'&&!steps.some(step=>step.id===source)||!steps.some(step=>step.id===target))return error('Edge endpoint not found');const index=edges.findIndex(edge=>edge.source===source&&edge.target===target);if(op==='CreateWorkflowVersionEdge'){if(index<0)edges.push({source,target,sourceConnectionOptions:raw.sourceConnectionOptions??null});}else if(index>=0)edges.splice(index,1);result=null;
  }else if(op==='UpdateWorkflowVersionTrigger'){
    if(!object(raw.trigger))return error('A valid trigger is required');trigger=raw.trigger;result={trigger};
  }else if(op==='UpdateWorkflowVersionPositions'){
    const positions=Array.isArray(raw.positions)?raw.positions:[];if(positions.length>200)return error('Too many positions');for(const position of positions){if(!object(position)||typeof position.id!=='string'||!object(position.position))continue;const step=steps.find(item=>item.id===position.id);if(step)step.position={x:Number(position.position.x??0),y:Number(position.position.y??0)};}result=true;
  }
  const now=new Date().toISOString();await db.prepare('UPDATE native_workflow_versions SET trigger_json=?,steps_json=?,edges_json=?,updated_at=? WHERE workspace_id=? AND id=? AND status=\'DRAFT\'').bind(trigger==null?null:json(trigger),json(steps),json(edges),now,workspaceId,version.id).run();const after={...version,trigger_json:trigger==null?null:json(trigger),steps_json:json(steps),edges_json:json(edges),updated_at:now};
  const root=op[0].toLowerCase()+op.slice(1);return Response.json({data:{[root]:result??diff(before,after)}});
}
