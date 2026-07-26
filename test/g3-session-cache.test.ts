import { describe, expect, it } from "vitest";
import {
  g3SessionCacheStatus,
  runG3SessionCacheSample,
} from "../src/g3-session-cache";
import type { Env } from "../src/types";

const SUMMARY_KEY = "g3:production:session-cache:summary";

function testEnv(
  options: { preserveDeletedCache?: boolean; failStateWrites?: boolean } = {},
): Env {
  const state = new Map<string, unknown>();
  const kv = new Map<string, string>();
  const stateKey = (input: { namespace: string; key: string }) =>
    `${input.namespace}:${input.key}`;
  const stub = {
    setValue: async (input: {
      namespace: string;
      key: string;
      value: unknown;
    }) => {
      if (options.failStateWrites) throw new Error("state unavailable");
      state.set(stateKey(input), input.value);
      return { found: true, value: input.value };
    },
    getValue: async (input: { namespace: string; key: string }) => ({
      found: state.has(stateKey(input)),
      value: state.get(stateKey(input)),
    }),
    deleteValue: async (input: { namespace: string; key: string }) => {
      if (
        options.preserveDeletedCache &&
        input.namespace === "cache"
      )
        return false;
      return state.delete(stateKey(input));
    },
  };
  return {
    INTERNAL_SERVICE_TOKEN: "internal-secret",
    STATE_DO: {
      idFromName: (name: string) => name,
      get: () => stub,
    },
    STATUS_KV: {
      get: async (key: string, type?: string) => {
        const value = kv.get(key);
        if (value === undefined) return null;
        return type === "json" ? JSON.parse(value) : value;
      },
      put: async (key: string, value: string) => {
        kv.set(key, value);
      },
    },
  } as unknown as Env;
}

describe("G3 production session/cache validation", () => {
  it("proves two-session isolation, permission invalidation, and token revocation", async () => {
    const env = testEnv();
    const firstAt = Date.parse("2026-07-26T00:00:00Z");
    const first = await runG3SessionCacheSample(env, firstAt);
    const second = await runG3SessionCacheSample(
      env,
      firstAt + 15 * 60_000,
    );

    expect(first).toMatchObject({
      samples: 1,
      failures: 0,
      sessionLosses: 0,
      permissionInvalidationFailures: 0,
      revocationFailures: 0,
      lastPassed: true,
    });
    expect(second).toMatchObject({
      samples: 2,
      failures: 0,
      maxGapMs: 15 * 60_000,
      lastPassed: true,
    });
    const status = await g3SessionCacheStatus(env);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      gate: "G3",
      status: "collecting",
      ready: false,
      samples: 2,
      requiredSamples: 672,
    });
  });

  it("records a permission invalidation failure instead of certifying it", async () => {
    const result = await runG3SessionCacheSample(
      testEnv({ preserveDeletedCache: true }),
      Date.parse("2026-07-26T00:00:00Z"),
    );
    expect(result).toMatchObject({
      samples: 1,
      failures: 1,
      permissionInvalidationFailures: 1,
      lastPassed: false,
    });
  });

  it("records a failed sample when the live state gateway is unavailable", async () => {
    const result = await runG3SessionCacheSample(
      testEnv({ failStateWrites: true }),
      Date.parse("2026-07-26T00:00:00Z"),
    );
    expect(result).toMatchObject({
      samples: 1,
      failures: 1,
      sessionLosses: 1,
      permissionInvalidationFailures: 1,
      revocationFailures: 1,
      lastPassed: false,
    });
  });

  it("reports passed only for a complete continuous seven-day ledger", async () => {
    const env = testEnv();
    const firstAt = "2026-07-19T00:00:00.000Z";
    const lastAt = "2026-07-26T00:00:00.000Z";
    await env.STATUS_KV.put(
      SUMMARY_KEY,
      JSON.stringify({
        firstAt,
        lastAt,
        samples: 672,
        failures: 0,
        sessionLosses: 0,
        permissionInvalidationFailures: 0,
        revocationFailures: 0,
        maxStateGatewayMs: 120,
        maxGapMs: 15 * 60_000,
        lastRunId: "g3-complete",
        lastPassed: true,
      }),
    );
    expect(await (await g3SessionCacheStatus(env)).json()).toMatchObject({
      status: "passed",
      ready: true,
      durationMs: 7 * 24 * 60 * 60_000,
    });
  });
});
