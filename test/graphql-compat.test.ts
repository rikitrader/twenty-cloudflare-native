import { describe, expect, it } from "vitest";
import { handleGraphql } from "../src/graphql-compat";

const request = (body: unknown, headers: Record<string, string> = {}) => new Request("https://example.test/graphql", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("GraphQL D1 compatibility boundary", () => {
  it("rejects requests without a configured identity", async () => {
    const response = await handleGraphql(request({ operationName: "FindManyPeople" }), {} as never);
    expect(response?.status).toBe(401);
  });

  it("returns null for non-GraphQL routes and methods", async () => {
    const env = { OPS_TOKEN: "test-token" } as never;
    expect(await handleGraphql(new Request("https://example.test/api", { method: "GET" }), env)).toBeNull();
  });

  it("answers the metadata event stream without falling through to assets", async () => {
    const response = await handleGraphql(new Request("https://example.test/metadata", { method: "GET" }), {} as never);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("text/event-stream");
    expect(await response?.text()).toContain("twenty-metadata-ready");
  });

  it("keeps invite resolution valid before authentication", async () => {
    const env = { CRM_DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) } } as never;
    const response = await handleGraphql(request({ operationName: "GetWorkspaceFromInviteHash", variables: { inviteHash: "unknown" } }), env);
    expect(response?.status).toBe(200);
    expect((await response?.json()) as { data: { workspace: unknown } }).toMatchObject({ data: { workspace: null } });
  });
});
