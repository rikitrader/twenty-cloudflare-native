import { describe, expect, it } from "vitest";
import {
  accessTokenRevoked,
  authBearerToken,
  revokeAccessToken,
} from "../src/auth-revocation";

function token(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.signature`;
}

function env(state: Map<string, unknown>) {
  const stub = {
    setValue: async (body: { key: string; value?: unknown }) => {
      state.set(body.key, body.value);
      return { updated: true };
    },
    getValue: async (body: { key: string }) => ({
      found: state.has(body.key),
      value: state.get(body.key),
    }),
  };
  return {
    INTERNAL_SERVICE_TOKEN: "internal",
    STATE_DO: {
      idFromName: () => "auth",
      get: () => stub,
    },
  } as never;
}

describe("access token revocation", () => {
  it("stores a bounded revocation marker and rejects the token", async () => {
    const state = new Map<string, unknown>();
    const value = token({ exp: Math.floor(Date.now() / 1000) + 300 });
    const request = new Request("https://example.com/_auth/revoke", {
      method: "POST",
      headers: { authorization: `Bearer ${value}` },
    });
    expect(authBearerToken(request)).toBe(value);
    expect((await revokeAccessToken(request, env(state))).status).toBe(200);
    expect(await accessTokenRevoked(new Request("https://example.com", { headers: { authorization: `Bearer ${value}` } }), env(state))).toBe(true);
  });

  it("fails closed for malformed revocation requests", async () => {
    const response = await revokeAccessToken(
      new Request("https://example.com/_auth/revoke", { method: "POST" }),
      env(new Map()),
    );
    expect(response.status).toBe(401);
  });

  it("revokes one concurrent session without invalidating another", async () => {
    const state = new Map<string, unknown>();
    const first = token({
      exp: Math.floor(Date.now() / 1000) + 300,
      sub: "session-one",
    });
    const second = token({
      exp: Math.floor(Date.now() / 1000) + 300,
      sub: "session-two",
    });
    await revokeAccessToken(
      new Request("https://example.com/_auth/revoke", {
        method: "POST",
        headers: { authorization: `Bearer ${first}` },
      }),
      env(state),
    );
    expect(
      await accessTokenRevoked(
        new Request("https://example.com", {
          headers: { authorization: `Bearer ${first}` },
        }),
        env(state),
      ),
    ).toBe(true);
    expect(
      await accessTokenRevoked(
        new Request("https://example.com", {
          headers: { authorization: `Bearer ${second}` },
        }),
        env(state),
      ),
    ).toBe(false);
  });
});
