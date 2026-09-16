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
});
