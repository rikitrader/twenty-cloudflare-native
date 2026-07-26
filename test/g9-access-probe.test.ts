import { afterEach, describe, expect, it, vi } from "vitest";
import probe from "../src/g9-access-probe";

const env = {
  PROBE_TOKEN: "probe-token",
  OPS_TOKEN: "ops-token",
  ACCESS_SERVICE_CLIENT_ID: "client.access",
  ACCESS_SERVICE_CLIENT_SECRET: "client-secret",
};

function request(body: unknown, token = "probe-token"): Request {
  return new Request("https://twenty-g9-access-probe.example/probe", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("G9 Access service probe", () => {
  it("fails closed before processing a proxy request", async () => {
    const response = await probe.fetch(
      request({ path: "/_ops/job-failures", method: "GET" }, "wrong"),
      env,
    );
    expect(response.status).toBe(401);
  });

  it("rejects origins and operations paths outside its allowlist", async () => {
    expect(
      (
        await probe.fetch(
          request({ path: "https://example.com/", method: "GET" }),
          env,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await probe.fetch(
          request({ path: "/_ops/unrelated", method: "GET" }),
          env,
        )
      ).status,
    ).toBe(403);
  });

  it("adds service credentials only to an allowed operations request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({ failures: [] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await probe.fetch(
      request({
        path: "/_ops/job-failures?limit=1",
        method: "GET",
      }),
      env,
    );

    expect(response.status).toBe(200);
    const [target, init] = fetchMock.mock.calls[0] as [
      URL,
      RequestInit,
    ];
    expect(target.origin).toBe(
      "https://twenty-crm-redis-free-canary.rikitrader.workers.dev",
    );
    const headers = new Headers(init.headers);
    expect(headers.get("cf-access-client-id")).toBe("client.access");
    expect(headers.get("cf-access-client-secret")).toBe("client-secret");
    expect(headers.get("authorization")).toBe("Bearer ops-token");
  });
});
