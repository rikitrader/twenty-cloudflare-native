import { describe, expect, it, vi } from "vitest";
import { handleGraphql } from "../src/graphql-compat";

const request = (body: unknown, headers: Record<string, string> = {}) => new Request("https://example.test/graphql", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("GraphQL D1 compatibility boundary", () => {
  it.each(['/graphql', '/metadata', '/api/graphql', '/api/metadata'])("routes Apollo email lookup with __typename through D1 at %s", async (path) => {
    const queries: string[] = [];
    const env = { CRM_DB: { prepare: (sql: string) => {
      queries.push(sql);
      return { bind: () => ({ first: async () => null }) };
    } } } as never;
    const response = await handleGraphql(new Request(`https://example.test${path}`, {
      method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({
        operationName: 'CheckUserExists', variables: { email: 'new-user@example.invalid' },
        query: 'query CheckUserExists($email: String!) { checkUserExists(email: $email) { exists availableWorkspacesCount isEmailVerified __typename } }',
      }),
    }), env);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ data: { checkUserExists: { exists:false, availableWorkspacesCount:0, isEmailVerified:false } } });
    expect(queries.some(sql => sql.includes('native_users'))).toBe(true);
  });

  it('does not treat __typename on a protected CRM query as public introspection', async () => {
    const response = await handleGraphql(request({ operationName:'FindManyPeople', query:'query FindManyPeople { people { id __typename } }' }), {} as never);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({errors:[{message:'unauthorized',extensions:{code:'UNAUTHENTICATED'}}]});
  });

  it('still recognizes an actual introspection field', async () => {
    const response = await handleGraphql(request({ query:'query Schema { __schema { queryType { name } } }' }), {} as never);
    expect(await response?.json()).toMatchObject({ data:{ __schema:{ queryType:{name:'Query'} } } });
  });

  it('returns valid same-origin workspace URLs to the Apollo welcome client', async () => {
    const env = { CRM_DB:{ prepare:() => ({ bind:() => ({ first:async()=>null }) }) } } as never;
    const response = await handleGraphql(request({ operationName:'GetPublicWorkspaceDataByDomain', variables:{ origin:'https://example.test' }, query:'query GetPublicWorkspaceDataByDomain { getPublicWorkspaceDataByDomain { displayName workspaceUrls { subdomainUrl customUrl __typename } __typename } }' }), env);
    const body = await response!.json() as {data:{getPublicWorkspaceDataByDomain:{workspaceUrls:{subdomainUrl:string}}}};
    expect(new URL(body.data.getPublicWorkspaceDataByDomain.workspaceUrls.subdomainUrl).origin).toBe('https://example.test');
  });

  it("rejects requests without a configured identity", async () => {
    const response = await handleGraphql(request({ operationName: "FindManyPeople" }), {} as never);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({errors:[{message:'unauthorized',extensions:{code:'UNAUTHENTICATED'}}]});
  });

  it("returns null for non-GraphQL routes and methods", async () => {
    const env = { OPS_TOKEN: "test-token" } as never;
    expect(await handleGraphql(new Request("https://example.test/api", { method: "GET" }), env)).toBeNull();
  });

  it("serves the authorized metadata event stream from workspace realtime state", async () => {
    const poll=vi.fn().mockResolvedValueOnce({id:1,payload:{eventId:'event-1',action:'create'}}).mockImplementation(()=>new Promise(()=>{}));
    const env={OPS_TOKEN:'test-token',CRM_DB:{prepare:()=>({bind:()=>({first:async()=>({workspaceId:'ws-1'})})})},PUBSUB_DO:{idFromName:(id:string)=>id,get:()=>({poll})}} as never;
    const response = await handleGraphql(new Request("https://example.test/metadata", { method: "GET" }), env);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("text/event-stream");
    const reader = response?.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toContain('event: ready');
    await reader?.cancel();
  });

  it('rejects unauthenticated metadata event streams',async()=>{
    const response=await handleGraphql(new Request('https://example.test/metadata',{method:'GET'}),{} as never);
    expect(response?.status).toBe(401);
  });

  it("keeps invite resolution valid before authentication", async () => {
    const env = { CRM_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } } as never;
    const response = await handleGraphql(request({ operationName: "GetWorkspaceFromInviteHash", variables: { inviteHash: "unknown" } }), env);
    expect(response?.status).toBe(200);
    expect((await response?.json()) as { data: { workspace: unknown } }).toMatchObject({ data: { workspace: null } });
  });

  it("keeps welcome metadata public when a stale session cookie is present", async () => {
    const response = await handleGraphql(
      request({ operationName: "FindMinimalMetadata", query: "query FindMinimalMetadata { findMinimalMetadata { objectMetadataItems { id } } }" }, { cookie: "twenty_session=expired" }),
      {} as never,
    );
    expect(response?.status).toBe(200);
    expect((await response?.json()) as { data: { minimalMetadata: unknown } }).toMatchObject({ data: { minimalMetadata: { objectMetadataItems: [] } } });
  });
});
