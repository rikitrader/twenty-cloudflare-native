import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const upstream = process.env.TWENTY_UPSTREAM ?? resolve(root, '../twenty-upstream');
const sources = [
  ['workspace', resolve(upstream, 'packages/twenty-front/src/generated/graphql.ts')],
  ['metadata', resolve(upstream, 'packages/twenty-front/src/generated-metadata/graphql.ts')],
];
const inventoryPath = resolve(root, 'docs/GRAPHQL-OPERATION-INVENTORY.json');
const providerDisabled = /(?:Billing|Checkout|Portal|Subscription|Enterprise|Dpa|LegalAgreement|AiProvider|ChatMessage|AgentChat|SendEmail|MessageCampaignTest|SendMessageCampaign|ConnectedAccount|ChannelSync|Sso|SAML|OIDC|IdentityProvider|Marketplace|Application|Imap|Smtp|Caldav|AuthorizeApp|GithubClaimAuthorizationUrl|EnrichWorkspaceCompany|CallRecording|EmailPasswordResetLink|SendInvitations|ResendWorkspaceInvitation|ValidateApprovedAccessDomain|CheckCustomDomainValidRecords|CheckPublicDomainValidRecords|VerifyEmailingDomain|UsageLimit|ResourceCreditPrice|ListPlans)/i;
const implementedProviderExceptions = /^(?:SendChatMessage|GetChatMessages|AnswerAgentChatQuestion|SendEmail)$/i;
const explicitUnavailable = /(?:ActivateWorkspace|WorkflowVersionStep|WorkflowVersionEdge|WorkflowVersionTrigger|ResetPageLayoutTabToDefault|AssignRoleToApiKey|UpdateMessageFolders|UploadWorkspaceLogo|UploadNewWorkspaceLogo|UploadWorkspaceMemberProfilePicture|QueueJob|RetryJobs|RetryWorkflowRun|StopWorkflowRun|UpdateWorkflowRunStep|RunEvaluationInput|SubmitFormStep|TestHttpRequest|ExecuteOneLogicFunction|EvaluateAgentTurn|Impersonate|Impersonation|Otp|TwoFactorAuthentication|GeneratePlaygroundToken|GenerateTransientToken|DeleteCurrentWorkspace|DeleteUserAccount|DeleteUserWorkspace|DuplicateMessageList)/i;
const implemented = /^(?:SignIn|SignUp|SignOut|RenewToken|RevokeUserSession|RevokeAllOtherUserSessions|CheckUserExists|GetLoginTokenFromCredentials|GetAuthTokensFromLoginToken|VerifyEmailAndGetLoginToken|VerifyEmailAndGetWorkspaceAgnosticToken|ValidatePasswordResetToken|UpdatePasswordViaResetToken|UpdateUserEmail|GetCurrentUser|CurrentUser|Me|FindMinimalMetadata|ObjectMetadataItems|GetPublicWorkspaceData|AvailableWorkspaces|GetWorkspaceCreationDefaults|GetWorkspaceFromInviteHash|CheckWorkspaceSubdomainAvailability|GetInviteSuggestions|UpdateWorkspace|UpdateWorkspaceMemberSettings|GetWorkspaceInvitations|DeleteWorkspaceInvitation|CreateFileUpload|CompleteFileUpload|FindMany|FindOne|CreateOne|CreateMany|UpdateOne|UpdateMany|DeleteOne|DeleteMany|DestroyOne|DestroyMany|RestoreOne|RestoreMany|Aggregate|ObjectRecordCounts|Search|CombinedFindManyRecords|BarChartData|LineChartData|PieChartData|GetCoreWorkflow|CreateCoreWorkflow|UpdateCoreWorkflow|DeleteCoreWorkflow|ActivateWorkflow|DeactivateWorkflow|RunWorkflow|TriggerWorkflow|GetWorkflowRun|CreateDraftFromWorkflowVersion|DiscardCoreWorkflowDraft|DuplicateWorkflow|GetWorkflowVersionContent|UpdateWorkflowVersionPositions|CreateWorkflowVersion|UpdateWorkflowVersion|DeleteWorkflowVersion|DuplicateWorkflowVersion|CreateView|UpdateView|DestroyView|GetViews|FindAllViews|DuplicateDashboard|FindFieldsWidgetViews|FindTableWidgetViews|UpsertFieldsWidget|UpsertViewWidget|UpdatePageLayoutWithTabsAndWidgets|ResetPageLayoutToDefault|GetRoles|UpdateWorkspaceMemberRole|UpsertFieldPermissions|UpsertObjectPermissions|UpsertPermissionFlags|UpsertRowLevelPermissionPredicates|AssignRoleToAgent|RemoveRoleFromAgent|GetWorkspaceMembers|CreateApiKey|GenerateApiKeyToken|GetApiKey|UpdateApiKey|RevokeApiKey|EventLogs|GetTimeline|FindAllRecordFormPageLayouts|AddQueryToEventStream|RemoveQueryFromEventStream|TrackAnalytics|CreateChatThread|GetChatThreads|RenameChatThread|ArchiveChatThread|UnarchiveChatThread|DeleteChatThread|StartWorkspaceSetupChat|CreateSkill|UpdateSkill|DeleteSkill|ActivateSkill|DeactivateSkill|GetLogicFunctionSourceCode|GetToolIndex|GetToolInputSchema|ComputeStepOutputSchema|CreateApprovedAccessDomain|DeleteApprovedAccessDomain|GetApprovedAccessDomains|CreatePublicDomain|DeletePublicDomain|CreateCalendarEvent|GetAddressDetails|GetAutoCompleteAddress|CreateUnsubscribeTopic|UpdateUnsubscribeTopic|DeleteUnsubscribeTopic|UnsubscribeTopics|GetUsageAnalytics|FindWorkspaceAiStats|GetAiChatUsage|GetAiSystemPromptPreview|GetResourceCreditUsage|UsageQuotaDefinitions|UsageQuotaScopeConsumption|UsageQuotasWithConsumption|GetAgentTurns|GetEmailingDomains|MyCalendarChannels|MyMessageChannels|MyMessageFolders|PreviewMessageCampaignAudience|CreateEmailGroupChannel|DeleteEmailGroupChannel|UpdateCalendarChannel|UpdateEmailGroupChannel|UpdateMessageChannel|CancelMessageCampaign|GetWebhook|GetWebhooks|CreateWebhook|UpdateWebhook|DeleteWebhook|ResetCommandMenuItem|UpdateCommandMenuItem|ResetPageLayoutWidgetToDefault|UpdateLabPublicFeatureFlag|CompleteBookCallOnboardingStep|GoBackToPreviousOnboardingStep|SkipSyncEmailOnboardingStep|TriggerInstallAppsOnboardingStep|MostlyEmptyFieldMetadataIds|ResetTimelineActivityType|UpdateTimelineActivityTypeIsActive)/i;

let output;
if (sources.every(([, path]) => existsSync(path))) {
  const operations = [];
  for (const [client, path] of sources) {
    const source = readFileSync(path, 'utf8');
    const seen = new Set();
    for (const match of source.matchAll(/export const ([A-Za-z0-9_]+)Document\s*=/g)) {
      const name = match[1]; if (seen.has(name)) continue; seen.add(name);
      const window = source.slice(match.index, match.index + 1400);
      const kind = /"operation":"mutation"/.test(window) ? 'mutation' : /"operation":"subscription"/.test(window) ? 'subscription' : 'query';
      const status = implementedProviderExceptions.test(name) ? 'implemented-review' : providerDisabled.test(name) ? 'provider-disabled-review' : explicitUnavailable.test(name) ? 'explicitly-unavailable' : implemented.test(name) ? 'implemented-review' : 'implementation-required';
      operations.push({ client, name, kind, status });
    }
  }
  operations.sort((a, b) => a.name.localeCompare(b.name) || a.client.localeCompare(b.client));
  const summary = operations.reduce((value, operation) => { value[operation.status] = (value[operation.status] ?? 0) + 1; return value; }, {});
  output = { generatedAt: new Date().toISOString(), upstream, total: operations.length, summary, operations };
  if (process.argv.includes('--write')) {
    writeFileSync(inventoryPath, `${JSON.stringify(output, null, 2)}\n`);
  } else {
    const committed = JSON.parse(readFileSync(inventoryPath, 'utf8'));
    if (JSON.stringify(committed.operations) !== JSON.stringify(output.operations)) {
      console.error('GraphQL operation inventory is stale; run npm run audit:operations:update with TWENTY_UPSTREAM configured.');
      process.exitCode = 2;
    }
  }
} else {
  output = JSON.parse(readFileSync(inventoryPath, 'utf8'));
  output.source = 'committed-inventory';
}
console.log(JSON.stringify({ total: output.total, summary: output.summary, source: output.source ?? 'upstream-check' }, null, 2));
if (output.operations.some((operation) => operation.status === 'unclassified' || operation.status === 'implementation-required')) process.exitCode = 2;
