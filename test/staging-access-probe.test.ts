import { afterEach, describe, expect, it, vi } from "vitest";
import probe from "../src/staging-access-probe";

const stagingFetch = vi.fn();
const env = {
  STAGING: { fetch: stagingFetch } as unknown as Fetcher,
  PROBE_TOKEN: "probe-token",
  OPS_TOKEN: "ops-token",
  ACCESS_SERVICE_CLIENT_ID: "client.access",
  ACCESS_SERVICE_CLIENT_SECRET: "client-secret",
};

function request(body: unknown, token = "probe-token"): Request {
  return new Request("https://twenty-enterprise-staging-probe.example/probe", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("enterprise staging Access probe", () => {
  it("fails closed and rejects requests outside staging allowlists", async () => {
    expect(
      (
        await probe.fetch(
          request({ path: "/_status", method: "GET" }, "wrong"),
          env,
        )
      ).status,
    ).toBe(401);
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
          request({ path: "/unrelated", method: "GET" }),
          env,
        )
      ).status,
    ).toBe(403);
  });

  it("uses a private binding for canaries and Access for operations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    stagingFetch.mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await probe.fetch(
      request({ path: "/_canary/keys", method: "GET" }),
      env,
    );
    await probe.fetch(
      request({ path: "/_ops/job-failures/summary", method: "GET" }),
      env,
    );

    expect(stagingFetch).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const canaryHeaders = new Headers(stagingFetch.mock.calls[0][1].headers);
    expect(canaryHeaders.get("x-canary-authorization")).toBeNull();
    expect(canaryHeaders.get("cf-access-client-id")).toBeNull();
    expect(
      new Headers(fetchMock.mock.calls[0][1].headers).get("authorization"),
    ).toBe("Bearer ops-token");
    for (const call of fetchMock.mock.calls) {
      const headers = new Headers(call[1].headers);
      expect(headers.get("cf-access-client-id")).toBe("client.access");
      expect(headers.get("cf-access-client-secret")).toBe("client-secret");
    }
  });

  it("proxies only authenticated, cursor-bounded realtime upgrades", async () => {
    const upstream = Response.json({ upgraded: true });
    stagingFetch.mockResolvedValueOnce(upstream);

    const response = await probe.fetch(
      new Request(
        "https://twenty-enterprise-staging-probe.example/realtime?channel=test-channel&after=42",
        {
          headers: {
            authorization: "Bearer probe-token",
            upgrade: "websocket",
          },
        },
      ),
      env,
    );

    expect(response).toBe(upstream);
    const [target, init] = stagingFetch.mock.calls[0];
    expect(String(target)).toBe(
      "https://twenty-crm-enterprise-staging.rikitrader.workers.dev/_canary/realtime?channel=test-channel&after=42",
    );
    const headers = new Headers(init.headers);
    expect(headers.get("x-canary-authorization")).toBeNull();
    expect(headers.get("upgrade")).toBe("websocket");

    expect(
      (
        await probe.fetch(
          new Request(
            "https://twenty-enterprise-staging-probe.example/realtime?channel=test-channel&after=nope",
            {
              headers: {
                authorization: "Bearer probe-token",
                upgrade: "websocket",
              },
            },
          ),
          env,
        )
      ).status,
    ).toBe(400);
  });
});
