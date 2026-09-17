import { describe, expect, it, vi } from "vitest";
import { healthResponse } from "../src/health";
import type { Env } from "../src/types";

function envWithResult(result: { ok: number } | Error): Env {
  return {
    CRM_DB: {
      prepare: vi.fn(() => ({
        first: vi.fn(async () => {
          if (result instanceof Error) throw result;
          return result;
        }),
      })),
    },
    CF_VERSION_METADATA: { id: "version-test" },
  } as unknown as Env;
}

describe("D1-backed health probe", () => {
  it("reports ready only after the authoritative D1 query succeeds", async () => {
    const response = await healthResponse(envWithResult({ ok: 1 }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      database: "ok",
      runtime: "cloudflare-d1",
      versionId: "version-test",
    });
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("fails closed when D1 is unavailable", async () => {
    const response = await healthResponse(envWithResult(new Error("offline")));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "unavailable",
      database: "unavailable",
    });
  });
});
