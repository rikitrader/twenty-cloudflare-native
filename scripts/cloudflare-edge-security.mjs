#!/usr/bin/env node

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const zoneId = process.env.CLOUDFLARE_ZONE_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const command = process.argv[2] ?? 'inspect';
const api = 'https://api.cloudflare.com/client/v4';

if (!accountId || !zoneId || !token) {
  console.error('CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID, and CLOUDFLARE_API_TOKEN are required.');
  process.exit(2);
}

async function cloudflare(path, init = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    const codes = Array.isArray(body.errors) ? body.errors.map(error => error.code).filter(Boolean) : [];
    throw new Error(`Cloudflare API ${response.status}${codes.length ? ` (${codes.join(',')})` : ''}`);
  }
  return body.result;
}

const customRules = [
  {
    ref: 'twenty_crm_block_unsafe_methods',
    description: 'Twenty CRM: block TRACE and CONNECT on the production hostname',
    expression: '(http.host eq "crm.mipolitico.com" and http.request.method in {"TRACE" "CONNECT"})',
    action: 'block',
    enabled: false,
  },
  {
    ref: 'twenty_crm_block_sensitive_paths',
    description: 'Twenty CRM: block common source and secret-file probes',
    expression: '(http.host eq "crm.mipolitico.com" and (starts_with(http.request.uri.path, "/.git") or starts_with(http.request.uri.path, "/.env") or starts_with(http.request.uri.path, "/wrangler.") or starts_with(http.request.uri.path, "/node_modules/")))',
    action: 'block',
    enabled: false,
  },
];

async function customEntrypoint() {
  try {
    return await cloudflare(`/zones/${zoneId}/rulesets/phases/http_request_firewall_custom/entrypoint`);
  } catch (error) {
    if (!String(error).includes('404')) throw error;
    return null;
  }
}

async function inspect() {
  const [entrypoint, logpush] = await Promise.all([
    customEntrypoint(),
    cloudflare(`/accounts/${accountId}/logpush/jobs?dataset=workers_trace_events`),
  ]);
  const rules = Array.isArray(entrypoint?.rules) ? entrypoint.rules : [];
  console.log(JSON.stringify({
    customWaf: customRules.map(expected => {
      const actual = rules.find(rule => rule.ref === expected.ref);
      return { ref: expected.ref, present: Boolean(actual), enabled: actual?.enabled ?? null, action: actual?.action ?? null };
    }),
    workersTraceEventsLogpush: Array.isArray(logpush)
      ? logpush.map(job => ({ id: job.id, name: job.name, enabled: job.enabled, destination_conf: job.destination_conf }))
      : [],
  }, null, 2));
}

async function applyDisabledWaf() {
  let entrypoint = await customEntrypoint();
  if (!entrypoint) {
    entrypoint = await cloudflare(`/zones/${zoneId}/rulesets`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'Twenty CRM custom protections',
        description: 'Host-scoped Twenty CRM protections; created disabled pending traffic validation.',
        kind: 'zone',
        phase: 'http_request_firewall_custom',
        rules: customRules,
      }),
    });
  } else {
    for (const expected of customRules) {
      const current = entrypoint.rules?.find(rule => rule.ref === expected.ref);
      if (current) {
        await cloudflare(`/zones/${zoneId}/rulesets/${entrypoint.id}/rules/${current.id}`, {
          method: 'PATCH', body: JSON.stringify(expected),
        });
      } else {
        await cloudflare(`/zones/${zoneId}/rulesets/${entrypoint.id}/rules`, {
          method: 'POST', body: JSON.stringify(expected),
        });
      }
    }
  }
  await inspect();
}

async function createDisabledLogpush() {
  const destination = process.env.LOGPUSH_DESTINATION_CONF;
  if (!destination) throw new Error('LOGPUSH_DESTINATION_CONF is required and must identify a customer-owned encrypted destination.');
  const existing = await cloudflare(`/accounts/${accountId}/logpush/jobs?dataset=workers_trace_events`);
  if (existing.some(job => job.name === 'twenty-crm-workers-traces')) {
    throw new Error('The twenty-crm-workers-traces job already exists; inspect it instead of creating a duplicate.');
  }
  const job = await cloudflare(`/accounts/${accountId}/logpush/jobs`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'twenty-crm-workers-traces',
      dataset: 'workers_trace_events',
      destination_conf: destination,
      enabled: false,
      logpull_options: 'timestamps=rfc3339&sample=1',
    }),
  });
  console.log(JSON.stringify({ id: job.id, name: job.name, enabled: job.enabled, dataset: job.dataset }, null, 2));
}

try {
  if (command === 'inspect') await inspect();
  else if (command === 'apply-waf-disabled') await applyDisabledWaf();
  else if (command === 'create-logpush-disabled') await createDisabledLogpush();
  else throw new Error('Usage: cloudflare-edge-security.mjs inspect|apply-waf-disabled|create-logpush-disabled');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
