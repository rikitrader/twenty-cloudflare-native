#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const graphql = read('src/graphql-compat.ts');
const workflowWebhook = read('src/workflow-webhook.ts');
const outbound = read('src/outbound-webhooks.ts');
const crm = read('src/d1-crm.ts');
const inventory = JSON.parse(read('docs/GRAPHQL-OPERATION-INVENTORY.json'));

const findings = [];
const requireSource = (condition, message) => { if (!condition) findings.push(message); };

requireSource(!/UpdateWorkspace\|ActivateWorkspace/.test(graphql), 'ActivateWorkspace is still aliased to workspace update');
requireSource(/Workspace activation state is not implemented/.test(graphql), 'ActivateWorkspace does not fail closed');
requireSource(/workflow could not be durably queued/.test(graphql), 'workflow queue failure can be reported as accepted');
requireSource(/password reset token was already consumed/.test(graphql), 'password reset mutation lacks an atomic consumption result');
requireSource(/duplicate workflow receipt is unavailable/.test(workflowWebhook) && /SELECT status FROM native_workflow_runs/.test(workflowWebhook), 'duplicate workflow webhooks do not return authoritative durable state');
requireSource(/if\(!workspaceId\)return;if\(!env\.CRM_DB\|\|!env\.JOBS_QUEUE\)throw new Error\('outbound webhook persistence or queue is unavailable'\)/.test(outbound), 'outbound webhook enqueue silently succeeds without durable infrastructure');
requireSource(/only queued or running exports can be cancelled/.test(crm), 'export cancellation can claim success without a state transition');

const mutations = inventory.operations.filter(operation => operation.kind === 'mutation');
const invalid = mutations.filter(operation => !['implemented-review', 'provider-disabled-review', 'explicitly-unavailable'].includes(operation.status));
requireSource(invalid.length === 0, `${invalid.length} mutation operations lack a fail-closed classification`);

const result = { checkedAt: new Date().toISOString(), mutations: mutations.length, findings };
console.log(JSON.stringify(result, null, 2));
if (findings.length) process.exitCode = 1;
