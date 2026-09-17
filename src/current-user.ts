import type { Env } from './types';
import type { AccessIdentity } from './access';
import { compatibilityId } from './compatibility-id';
import { crmPermissions } from './crm-records';

/** Called only after the server's workspace-membership authorization check. */
export async function currentUserResponse(request: Request, env: Env, actor: AccessIdentity, workspaceId: string): Promise<Response> {
  const db = env.CRM_DB!;
  const profile = await db.prepare('SELECT display_name as displayName, locale FROM voter_profiles WHERE workspace_id = ? AND identity_subject = ? LIMIT 1')
    .bind(workspaceId, actor.subject).first<{displayName:string|null;locale:string|null}>();
  const memberships = await db.prepare("SELECT w.id, w.name, COALESCE('custom:' || ra.role_id,m.role) AS role, ra.role_id as roleId, cr.label as roleLabel, m.created_at as createdAt FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id LEFT JOIN role_assignments ra ON ra.workspace_id=m.workspace_id AND ra.identity_subject=m.identity_subject LEFT JOIN custom_roles cr ON cr.workspace_id=m.workspace_id AND cr.id=ra.role_id WHERE m.identity_subject = ? AND m.status = 'active' ORDER BY m.created_at")
    .bind(actor.subject).all<{id:string;name:string;role:string;roleId:string|null;roleLabel:string|null;createdAt:string}>();
  const workspace = memberships.results.find(w=>w.id===workspaceId);
  if(!workspace) return Response.json({errors:[{message:'forbidden'}]},{status:403});
  const count = await db.prepare("SELECT COUNT(*) as count FROM workspace_members WHERE workspace_id = ? AND status = 'active'").bind(workspaceId).first<{count:number}>();
  const origin = new URL(request.url).origin;
  const workspaceUrls = {__typename:'WorkspaceUrls',subdomainUrl:origin,customUrl:null};
  const displayName = profile?.displayName || (actor.email ?? '').split('@')[0];
  const name = {__typename:'FullName',firstName:displayName,lastName:''};
  const locale = profile?.locale === 'es-VE' ? 'es-ES' : profile?.locale ?? 'es-ES';
  const memberId = await compatibilityId(`member:${workspaceId}:${actor.subject}`);
  const userId = actor.subject.startsWith('user:') ? actor.subject.slice(5) : await compatibilityId(`user:${actor.subject}`);
  const workspaceMember = {
    __typename:'WorkspaceMember',id:memberId,userId,
    workspaceId,userWorkspaceId:memberId,userEmail:actor.email ?? '',
    name,role:workspace.role,status:'active',locale,createdAt:workspace.createdAt,
    roles:[workspace.roleId?{__typename:'Role',id:workspace.roleId,label:workspace.roleLabel??'Custom role',isEditable:true}: {__typename:'Role',id:workspace.role,label:workspace.role[0].toUpperCase()+workspace.role.slice(1),isEditable:false}],
    avatarUrl:null,colorScheme:'System',uiScale:'STANDARD',openRecordIn:'SIDE_PANEL',
    timeZone:'UTC',dateFormat:'SYSTEM',timeFormat:'SYSTEM',numberFormat:'SYSTEM',calendarStartDay:1,
  };
  const currentWorkspace = {
    __typename:'Workspace',id:workspaceId,displayName:workspace.name,name:workspace.name,
    activationStatus:'ACTIVE',isPasswordAuthEnabled:true,isPublicInviteLinkEnabled:false,
    workspaceUrls,installedApplications:[],featureFlags:[],workspaceMembersCount:count?.count ?? 0,
    defaultRole:null,currentBillingSubscription:null,billingCustomer:null,billingSubscriptions:[],billingEntitlements:[],
    logo:null,inviteHash:null,allowImpersonation:false,workspaceDiscoverability:'NOT_DISCOVERABLE',
    isGoogleAuthEnabled:false,isMicrosoftAuthEnabled:false,isGoogleAuthBypassEnabled:false,
    isMicrosoftAuthBypassEnabled:false,isPasswordAuthBypassEnabled:false,
    subdomain:new URL(request.url).hostname.split('.')[0],customDomain:null,isCustomDomainEnabled:false,
    hasValidSignedEnterpriseKey:false,hasValidEnterpriseValidityToken:false,workspaceCustomApplication:null,
    aiChatModelTier:null,aiAgentModelTier:null,isAutoModelSelectionEnabled:false,aiModelIdByTier:{},
    aiAdditionalInstructions:null,isTwoFactorAuthenticationEnforced:false,
    trashRetentionDays:30,eventLogRetentionDays:30,editableProfileFields:[],isInternalMessagesImportEnabled:false,
  };
  // Explicit GraphQL typenames are required for Apollo to retain fragment data.
  // Every listed workspace comes from this authenticated identity's membership.
  const availableWorkspaces = {
    __typename:'AvailableWorkspaces',
    availableWorkspacesForSignIn:memberships.results.map(w=>({
      __typename:'AvailableWorkspace',id:w.id,displayName:w.name,workspaceUrls,
      loginToken:null,inviteHash:null,personalInviteToken:null,logo:null,sso:[],
    })),availableWorkspacesForSignUp:[],
  };
  const readOnlyObjects = new Set(['workspaceMember','workflow','workflowVersion']);
  const objectsPermissions = await Promise.all(['person','company','opportunity','activity',...readOnlyObjects].map(async object=>{
    const permissions=await crmPermissions(env,workspaceId,workspace.role,object);
    return {__typename:'ObjectPermission',objectMetadataId:await compatibilityId(`object:${workspaceId}:${object}`),
      canReadObjectRecords:object==='workspaceMember'||permissions.read,
      canUpdateObjectRecords:!readOnlyObjects.has(object)&&permissions.update,
      canSoftDeleteObjectRecords:!readOnlyObjects.has(object)&&permissions.delete,canDestroyObjectRecords:!readOnlyObjects.has(object)&&permissions.delete,
      restrictedFields:{},rowLevelPermissionPredicates:[],rowLevelPermissionPredicateGroups:[]};
  }));
  const user = {
    __typename:'User',id:userId,userId,firstName:displayName,lastName:'',
    email:actor.email ?? '',displayName,locale,hasPassword:actor.subject.startsWith('user:'),
    // A workspace owner is not a server-wide administrator or impersonator.
    canAccessFullAdminPanel:false,canImpersonate:false,
    onboardingStatus:'COMPLETED',previousOnboardingStatus:null,isWorkspaceCreator:workspace.role==='owner',
    supportUserHash:null,workspaceMember,workspaceMembers:[workspaceMember],deletedWorkspaceMembers:[],
    currentUserWorkspace:{__typename:'UserWorkspace',id:workspaceMember.userWorkspaceId,
      permissionFlags:['PROFILE_INFORMATION','VIEWS',...(['owner','admin'].includes(workspace.role)?['WORKSPACE','DATA_MODEL','LAYOUTS','WORKSPACE_MEMBERS','ROLES']:[])],
      isImpersonating:false,objectsPermissions,twoFactorAuthenticationMethodSummary:[]},
    currentWorkspace,availableWorkspaces,userVars:{},
  };
  return Response.json({data:{currentUser:user,me:user}},{headers:{'cache-control':'no-store'}});
}
