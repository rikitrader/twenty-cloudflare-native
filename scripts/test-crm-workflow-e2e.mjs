import assert from "node:assert/strict";

const BASE_URL =
  process.env.TWENTY_BASE_URL ??
  "https://twenty-crm.rikitrader.workers.dev";
const WORKFLOW_ID =
  process.env.TWENTY_WORKFLOW_ID ??
  "887c6c06-fbc5-4b45-8d6b-f7b6b0f40b12";
const CDP_URL = process.env.TWENTY_CDP_URL;
const TIMEOUT_MS = Number(process.env.TWENTY_E2E_TIMEOUT_MS ?? 180_000);
const POLL_MS = Number(process.env.TWENTY_E2E_POLL_MS ?? 2_000);

const PERSONAL_EMAIL_STEP_ID = "c30d7cbe-00e0-4966-bc1a-99b0a11a2cca";
const BUSINESS_FILTER_STEP_ID = "01f3db05-aae5-4e4b-b361-96684f09c704";
const CREATE_COMPANY_STEP_ID = "ddafb9db-a94f-40b9-a5c9-becce857edf7";
const ATTACH_NEW_COMPANY_STEP_ID = "d5d5d6e1-391f-4142-83c1-670f7087f079";
const ATTACH_EXISTING_COMPANY_STEP_ID =
  "ffdd4271-75d4-4805-b1f8-2167a113c3b2";
const TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "FAILED", "STOPPED"]);

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const getTokenFromCdp = async (websocketUrl) => {
  const socket = new WebSocket(websocketUrl);
  let nextId = 1;
  const pending = new Map();

  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const handler = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
    else handler.resolve(message.result);
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  try {
    await call("Runtime.enable");
    const result = await call("Runtime.evaluate", {
      expression:
        'JSON.parse(localStorage.getItem("tokenPairState")).accessOrWorkspaceAgnosticToken.token',
      returnByValue: true,
    });
    const token = result.result?.value;
    assert.equal(typeof token, "string", "Chrome did not expose an access token");
    assert.ok(token.length > 100, "Chrome access token is unexpectedly short");
    return token;
  } finally {
    socket.close();
  }
};

const token =
  process.env.TWENTY_ACCESS_TOKEN ??
  process.env.TWENTY_API_KEY ??
  (CDP_URL ? await getTokenFromCdp(CDP_URL) : null);

assert.ok(
  token,
  "Set TWENTY_ACCESS_TOKEN, TWENTY_API_KEY, or TWENTY_CDP_URL",
);

const authHeaders = {
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
};

const apiRequest = async (path, options = {}) => {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: { ...authHeaders, ...options.headers },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    throw new Error(
      `${options.method ?? "GET"} ${path} returned ${response.status}: ${JSON.stringify(payload)}`,
    );
  }
  return payload;
};

const graphql = async (query, variables) => {
  const payload = await apiRequest("/graphql", {
    method: "POST",
    body: JSON.stringify({ query, variables }),
  });
  if (payload.errors?.length) {
    throw new Error(`GraphQL failed: ${JSON.stringify(payload.errors)}`);
  }
  return payload.data;
};

const listWorkflowRuns = async () => {
  const payload = await apiRequest("/rest/workflowRuns?limit=60");
  return payload.data.workflowRuns;
};

const findWorkflowRunForPerson = async (personId) =>
  (await listWorkflowRuns()).find(
    (run) =>
      run.workflowId === WORKFLOW_ID &&
      run.state?.stepInfos?.trigger?.result?.recordId === personId,
  );

const waitForWorkflowRun = async (personId) => {
  const deadline = Date.now() + TIMEOUT_MS;
  let run = null;

  while (Date.now() < deadline) {
    run = await findWorkflowRunForPerson(personId);
    if (run && TERMINAL_RUN_STATUSES.has(run.status)) return run;
    await sleep(POLL_MS);
  }

  throw new Error(
    `Workflow did not finish for person ${personId}; last status ${run?.status ?? "not-created"}`,
  );
};

const waitFor = async (description, predicate) => {
  const deadline = Date.now() + TIMEOUT_MS;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_MS);
  }

  throw new Error(
    `Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`,
  );
};

const createPerson = async (firstName, lastName, email) => {
  const payload = await apiRequest("/rest/people", {
    method: "POST",
    body: JSON.stringify({
      name: { firstName, lastName },
      emails: { primaryEmail: email, additionalEmails: [] },
    }),
  });
  return payload.data.createPerson;
};

const getPerson = async (personId) => {
  const payload = await apiRequest(`/rest/people/${personId}`);
  return payload.data.person;
};

const listCompanies = async () => {
  const payload = await apiRequest("/rest/companies?limit=60");
  return payload.data.companies;
};

const destroyPerson = async (id) => {
  await graphql(
    "mutation DeleteE2EPerson($id: UUID!) { deletePerson(id: $id) { id } }",
    { id },
  );
  await graphql(
    "mutation DestroyE2EPerson($id: UUID!) { destroyPerson(id: $id) { id } }",
    { id },
  );
};

const destroyCompany = async (id) => {
  await graphql(
    "mutation DeleteE2ECompany($id: UUID!) { deleteCompany(id: $id) { id } }",
    { id },
  );
  await graphql(
    "mutation DestroyE2ECompany($id: UUID!) { destroyCompany(id: $id) { id } }",
    { id },
  );
};

const assertRunCompleted = (run, branch) => {
  assert.equal(
    run.status,
    "COMPLETED",
    `${branch} run failed: ${run.state?.workflowRunError ?? "unknown error"}`,
  );
  assert.equal(
    run.state?.stepInfos?.[PERSONAL_EMAIL_STEP_ID]?.status,
    "SUCCESS",
    `${branch} did not execute the personal-email classifier`,
  );
};

const createdPersonIds = [];
let createdCompanyId = null;
let testError = null;
const nonce = Date.now().toString(36);
const domain = `twenty-e2e-${nonce}.com`;
const evidence = {};

try {
  const personalPerson = await createPerson(
    "E2E",
    `Personal ${nonce}`,
    `twenty.e2e.${nonce}@gmail.com`,
  );
  createdPersonIds.push(personalPerson.id);

  const personalRun = await waitForWorkflowRun(personalPerson.id);
  assertRunCompleted(personalRun, "personal-email");
  assert.equal(
    personalRun.state.stepInfos[PERSONAL_EMAIL_STEP_ID].result?.isPersonal,
    true,
    "Personal email was not classified as personal",
  );
  assert.equal(
    personalRun.state.stepInfos[BUSINESS_FILTER_STEP_ID]?.status,
    "STOPPED",
    "Personal-email branch did not stop at the business filter",
  );
  assert.equal(
    (await getPerson(personalPerson.id)).companyId,
    null,
    "Personal-email person was unexpectedly attached to a company",
  );
  evidence.personalEmailRunId = personalRun.id;
  console.log(`personal-email branch passed: ${personalRun.id}`);

  const newCompanyPerson = await createPerson(
    "E2E",
    `New Company ${nonce}`,
    `first@${domain}`,
  );
  createdPersonIds.push(newCompanyPerson.id);

  const newCompanyRun = await waitForWorkflowRun(newCompanyPerson.id);
  assertRunCompleted(newCompanyRun, "new-company");
  assert.equal(
    newCompanyRun.state.stepInfos[CREATE_COMPANY_STEP_ID]?.status,
    "SUCCESS",
    "New-company branch did not create a company",
  );
  assert.equal(
    newCompanyRun.state.stepInfos[ATTACH_NEW_COMPANY_STEP_ID]?.status,
    "SUCCESS",
    "New-company branch did not attach the person",
  );

  const attachedNewCompanyPerson = await waitFor(
    "new-company person attachment",
    async () => {
      const person = await getPerson(newCompanyPerson.id);
      return person.companyId ? person : null;
    },
  );
  assert.ok(
    attachedNewCompanyPerson.companyId,
    "New-company person has no companyId",
  );
  createdCompanyId = attachedNewCompanyPerson.companyId;

  const createdCompany = await waitFor(
    "workflow-created company visibility",
    async () =>
      (await listCompanies()).find((company) => company.id === createdCompanyId),
  );
  assert.ok(createdCompany, "Workflow-created company was not found");
  assert.equal(createdCompany.name, domain);
  assert.equal(createdCompany.domainName.primaryLinkUrl, `https://${domain}`);
  evidence.newCompanyRunId = newCompanyRun.id;
  evidence.createdCompanyId = createdCompanyId;
  console.log(`new-company branch passed: ${newCompanyRun.id}`);

  const existingCompanyPerson = await createPerson(
    "E2E",
    `Existing Company ${nonce}`,
    `second@${domain}`,
  );
  createdPersonIds.push(existingCompanyPerson.id);

  const existingCompanyRun = await waitForWorkflowRun(existingCompanyPerson.id);
  assertRunCompleted(existingCompanyRun, "existing-company");
  assert.equal(
    existingCompanyRun.state.stepInfos[ATTACH_EXISTING_COMPANY_STEP_ID]?.status,
    "SUCCESS",
    "Existing-company branch did not attach the person",
  );
  assert.equal(
    existingCompanyRun.state.stepInfos[CREATE_COMPANY_STEP_ID]?.status,
    "SKIPPED",
    "Existing-company branch created a duplicate company",
  );
  assert.equal(
    (await getPerson(existingCompanyPerson.id)).companyId,
    createdCompanyId,
    "Existing-company person was attached to the wrong company",
  );
  const matchingCompanies = (await listCompanies()).filter(
    (company) => company.domainName?.primaryLinkUrl === `https://${domain}`,
  );
  assert.equal(matchingCompanies.length, 1, "Workflow created duplicate companies");
  evidence.existingCompanyRunId = existingCompanyRun.id;
  console.log(`existing-company branch passed: ${existingCompanyRun.id}`);

  const deletedRun = await graphql(
    "mutation DeleteE2EWorkflowRun($id: UUID!) { deleteWorkflowRun(id: $id) { id deletedAt } }",
    { id: personalRun.id },
  );
  assert.equal(deletedRun.deleteWorkflowRun.id, personalRun.id);
  assert.ok(
    deletedRun.deleteWorkflowRun.deletedAt,
    "Workflow Run delete did not set deletedAt",
  );

  const restoredRun = await graphql(
    "mutation RestoreE2EWorkflowRun($id: UUID!) { restoreWorkflowRun(id: $id) { id deletedAt } }",
    { id: personalRun.id },
  );
  assert.equal(restoredRun.restoreWorkflowRun.id, personalRun.id);
  assert.equal(
    restoredRun.restoreWorkflowRun.deletedAt,
    null,
    "Workflow Run restore did not clear deletedAt",
  );
  console.log(`workflow-run delete/restore passed: ${personalRun.id}`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        workflowId: WORKFLOW_ID,
        domain,
        evidence,
      },
      null,
      2,
    ),
  );
} catch (error) {
  testError = error;
} finally {
  const cleanupErrors = [];
  for (const personId of createdPersonIds.reverse()) {
    try {
      await destroyPerson(personId);
    } catch (error) {
      cleanupErrors.push(`person ${personId}: ${error.message}`);
    }
  }
  if (createdCompanyId) {
    try {
      await destroyCompany(createdCompanyId);
    } catch (error) {
      cleanupErrors.push(`company ${createdCompanyId}: ${error.message}`);
    }
  }

  if (cleanupErrors.length) {
    const cleanupError = new Error(`Cleanup failed: ${cleanupErrors.join("; ")}`);
    if (testError) cleanupError.cause = testError;
    throw cleanupError;
  }
}

if (testError) throw testError;
