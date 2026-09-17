import assert from "node:assert/strict";

const baseUrl = (process.env.TWENTY_BASE_URL ?? "https://twenty-crm.observatorio-publico.workers.dev").replace(/\/$/, "");
const cases = [
  ["FindMinimalMetadata", "query FindMinimalMetadata { findMinimalMetadata { objectMetadataItems { id } } }", 200],
  ["GetPublicWorkspaceDataByDomain", "query GetPublicWorkspaceDataByDomain { getPublicWorkspaceDataByDomain { id } }", 200],
  ["CheckUserExists", "query CheckUserExists { checkUserExists { exists } }", 200],
  ["GetWorkspaceFromInviteHash", "query GetWorkspaceFromInviteHash { getWorkspaceFromInviteHash { id } }", 200],
  ["IntrospectionQuery", "query IntrospectionQuery { __schema { queryType { name } } }", 200],
  ["FindManyPeople", "query FindManyPeople { people { nodes { id } } }", 401],
];

for (const [operationName, query, expectedStatus] of cases) {
  const response = await fetch(`${baseUrl}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationName, query, variables: {} }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  assert.equal(response.status, expectedStatus, `${operationName} returned ${response.status}: ${JSON.stringify(payload)}`);
  assert.ok(payload && (payload.data || payload.errors), `${operationName} returned no GraphQL payload`);
}

console.log(JSON.stringify({ result: "passed", endpoint: `${baseUrl}/graphql`, cases: cases.map(([operationName]) => operationName) }, null, 2));
