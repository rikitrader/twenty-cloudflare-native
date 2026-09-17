import type { Env } from './types';
import { compatibilityId } from './compatibility-id';

type Row=Record<string,any>;
export async function workspaceMemberRecords(op:string,vars:Row,env:Env,workspaceId:string):Promise<Response|null> {
  if(!['FindOneWorkspaceMember','FindManyWorkspaceMembers','GetWorkspaceMembers'].includes(op)) return null;
  const rows=await env.CRM_DB!.prepare("SELECT m.identity_subject,m.created_at,u.id AS user_id,u.email,p.display_name,p.locale FROM workspace_members m LEFT JOIN native_users u ON m.identity_subject='user:' || u.id LEFT JOIN voter_profiles p ON p.workspace_id=m.workspace_id AND p.identity_subject=m.identity_subject WHERE m.workspace_id=? AND m.status='active' ORDER BY m.created_at,m.identity_subject LIMIT 201").bind(workspaceId).all<Row>();
  const nodes=await Promise.all(rows.results.slice(0,200).map(async row=>({
    __typename:'WorkspaceMember',id:await compatibilityId(`member:${workspaceId}:${row.identity_subject}`),
    userWorkspaceId:await compatibilityId(`member:${workspaceId}:${row.identity_subject}`),
    userId:row.user_id??await compatibilityId(`user:${row.identity_subject}`),userEmail:row.email??'',
    name:{__typename:'FullName',firstName:row.display_name||String(row.email??'Workspace member').split('@')[0],lastName:''},
    avatarUrl:null,colorScheme:'System',uiScale:'STANDARD',locale:row.locale??'en',timeZone:'UTC',
    dateFormat:'SYSTEM',timeFormat:'SYSTEM',numberFormat:'SYSTEM',calendarStartDay:1,openRecordIn:'SIDE_PANEL',
    createdAt:row.created_at,updatedAt:row.created_at,deletedAt:null,
  })));
  const id=String(vars.objectRecordId??vars.id??vars.idToFind??vars.filter?.id?.eq??'');
  if(op==='FindOneWorkspaceMember') return Response.json({data:{workspaceMember:nodes.find(node=>node.id===id)??null}});
  const filtered=id?nodes.filter(node=>node.id===id):nodes;
  return Response.json({data:{workspaceMembers:{__typename:'WorkspaceMemberConnection',edges:filtered.map(node=>({__typename:'WorkspaceMemberEdge',node,cursor:node.id})),pageInfo:{__typename:'PageInfo',hasNextPage:rows.results.length>200,hasPreviousPage:false,startCursor:filtered[0]?.id??null,endCursor:filtered.at(-1)?.id??null},totalCount:filtered.length}}});
}
