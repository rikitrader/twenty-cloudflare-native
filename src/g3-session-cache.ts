import {
  accessTokenRevoked,
  revokeAccessToken,
} from "./auth-revocation";
import { handleStateGateway } from "./cloudflare-state/gateway";
import type { Env } from "./types";

const SUMMARY_KEY = "g3:production:session-cache:summary";
const SAMPLE_INTERVAL_MS = 15 * 60_000;
const REQUIRED_DURATION_MS = 7 * 24 * 60 * 60_000;
const REQUIRED_SAMPLES = REQUIRED_DURATION_MS / SAMPLE_INTERVAL_MS;
const MAX_SAMPLE_MS = 5_000;
const MAX_GAP_MS = 30 * 60_000;
const PROBE_TTL_MS = 30 * 60_000;

interface G3Summary {
  firstAt: string;
  lastAt: string;
  samples: number;
  consecutivePassedSamples: number;
  cleanWindowStartedAt: string;
  failures: number;
  lastFailureAt: string | null;
  sessionLosses: number;
  permissionInvalidationFailures: number;
  revocationFailures: number;
  maxStateGatewayMs: number;
  maxGapMs: number;
  lastRunId: string;
  lastPassed: boolean;
}

interface StateResult {
  found?: boolean;
  value?: unknown;
  deleted?: boolean;
}

function jwtFor(subject: string, expiresAtSeconds: number): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    sub: subject,
    exp: expiresAtSeconds,
  })}.g3`;
}

async function stateCall(
  env: Env,
  path: string,
  namespace: "cache" | "session",
  body: Record<string, unknown>,
): Promise<StateResult> {
  const response = await handleStateGateway(
    new Request(`http://twenty-state.internal${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.INTERNAL_SERVICE_TOKEN}`,
        "content-type": "application/json",
        "x-twenty-state-shard": "workspace:default",
      },
      body: JSON.stringify({ namespace, ...body }),
    }),
    env,
  );
  const result = (await response.json()) as StateResult & { error?: string };
  if (!response.ok)
    throw new Error(
      `G3 state gateway ${path} failed (${response.status}): ${
        result.error ?? "unknown error"
      }`,
    );
  return result;
}

export async function runG3SessionCacheSample(
  env: Env,
  now = Date.now(),
): Promise<G3Summary> {
  if (!env.INTERNAL_SERVICE_TOKEN)
    throw new Error("G3 requires INTERNAL_SERVICE_TOKEN");

  const runId = `g3-${now}-${crypto.randomUUID().slice(0, 8)}`;
  const sessionOneKey = `engine:session:${runId}:one`;
  const sessionTwoKey = `engine:session:${runId}:two`;
  const permissionKey = `permissions:${runId}:member`;
  const started = performance.now();
  let sessionPassed = false;
  let permissionPassed = false;
  let revocationPassed = false;

  try {
    await Promise.all([
      stateCall(env, "/v1/state/set", "session", {
        key: sessionOneKey,
        value: { subject: "g3-one", runId },
        ttlMs: PROBE_TTL_MS,
      }),
      stateCall(env, "/v1/state/set", "session", {
        key: sessionTwoKey,
        value: { subject: "g3-two", runId },
        ttlMs: PROBE_TTL_MS,
      }),
    ]);
    const [sessionOne, sessionTwo] = await Promise.all([
      stateCall(env, "/v1/state/get", "session", { key: sessionOneKey }),
      stateCall(env, "/v1/state/get", "session", { key: sessionTwoKey }),
    ]);
    sessionPassed =
      sessionOne.found === true &&
      sessionTwo.found === true &&
      (sessionOne.value as { subject?: unknown } | undefined)?.subject ===
        "g3-one" &&
      (sessionTwo.value as { subject?: unknown } | undefined)?.subject ===
        "g3-two";

    await stateCall(env, "/v1/state/set", "cache", {
      key: permissionKey,
      value: { role: "member", runId },
      ttlMs: PROBE_TTL_MS,
    });
    const beforeInvalidation = await stateCall(
      env,
      "/v1/state/get",
      "cache",
      { key: permissionKey },
    );
    await stateCall(env, "/v1/state/delete", "cache", {
      key: permissionKey,
    });
    const [afterInvalidation, unaffectedSession] = await Promise.all([
      stateCall(env, "/v1/state/get", "cache", { key: permissionKey }),
      stateCall(env, "/v1/state/get", "session", { key: sessionTwoKey }),
    ]);
    permissionPassed =
      beforeInvalidation.found === true &&
      afterInvalidation.found === false &&
      unaffectedSession.found === true &&
      (unaffectedSession.value as { subject?: unknown } | undefined)
        ?.subject === "g3-two";

    const expiresAt = Math.floor(now / 1000) + 20 * 60;
    const sessionOneToken = jwtFor(`${runId}:one`, expiresAt);
    const sessionTwoToken = jwtFor(`${runId}:two`, expiresAt);
    const revokeResponse = await revokeAccessToken(
      new Request("https://g3.internal/_auth/revoke", {
        method: "POST",
        headers: { authorization: `Bearer ${sessionOneToken}` },
      }),
      env,
    );
    const [sessionOneRevoked, sessionTwoRevoked] = await Promise.all([
      accessTokenRevoked(
        new Request("https://g3.internal/", {
          headers: { authorization: `Bearer ${sessionOneToken}` },
        }),
        env,
      ),
      accessTokenRevoked(
        new Request("https://g3.internal/", {
          headers: { authorization: `Bearer ${sessionTwoToken}` },
        }),
        env,
      ),
    ]);
    revocationPassed =
      revokeResponse.ok && sessionOneRevoked && !sessionTwoRevoked;
  } catch (error) {
    console.error(
      "G3 production session/cache sample failed",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    await Promise.allSettled([
      stateCall(env, "/v1/state/delete", "session", { key: sessionOneKey }),
      stateCall(env, "/v1/state/delete", "session", { key: sessionTwoKey }),
      stateCall(env, "/v1/state/delete", "cache", { key: permissionKey }),
    ]);
  }

  const stateGatewayMs = performance.now() - started;
  const passed =
    sessionPassed &&
    permissionPassed &&
    revocationPassed &&
    stateGatewayMs <= MAX_SAMPLE_MS;
  const existing = await env.STATUS_KV.get<G3Summary>(SUMMARY_KEY, "json");
  const checkedAt = new Date(now).toISOString();
  const gapMs = existing
    ? Math.max(0, now - Date.parse(existing.lastAt))
    : 0;
  const summary: G3Summary = {
    firstAt: existing?.firstAt ?? checkedAt,
    lastAt: checkedAt,
    samples: (existing?.samples ?? 0) + 1,
    consecutivePassedSamples: passed
      ? (existing?.lastPassed
          ? existing.consecutivePassedSamples ?? 0
          : 0) + 1
      : 0,
    cleanWindowStartedAt:
      passed && existing?.lastPassed
        ? existing.cleanWindowStartedAt ?? existing.lastAt
        : checkedAt,
    failures: (existing?.failures ?? 0) + (passed ? 0 : 1),
    lastFailureAt: passed ? existing?.lastFailureAt ?? null : checkedAt,
    sessionLosses:
      (existing?.sessionLosses ?? 0) + (sessionPassed ? 0 : 1),
    permissionInvalidationFailures:
      (existing?.permissionInvalidationFailures ?? 0) +
      (permissionPassed ? 0 : 1),
    revocationFailures:
      (existing?.revocationFailures ?? 0) + (revocationPassed ? 0 : 1),
    maxStateGatewayMs:
      passed && existing?.lastPassed
        ? Math.max(existing.maxStateGatewayMs, stateGatewayMs)
        : stateGatewayMs,
    maxGapMs:
      passed && existing?.lastPassed
        ? Math.max(existing.maxGapMs, gapMs)
        : 0,
    lastRunId: runId,
    lastPassed: passed,
  };
  await env.STATUS_KV.put(SUMMARY_KEY, JSON.stringify(summary));
  return summary;
}

export async function g3SessionCacheStatus(env: Env): Promise<Response> {
  const summary = await env.STATUS_KV.get<G3Summary>(SUMMARY_KEY, "json");
  if (!summary)
    return Response.json({
      gate: "G3",
      status: "collecting",
      ready: false,
      samples: 0,
      consecutivePassedSamples: 0,
      requiredSamples: REQUIRED_SAMPLES,
      requiredDurationMs: REQUIRED_DURATION_MS,
    });
  const durationMs = Math.max(
    0,
    Date.parse(summary.lastAt) - Date.parse(summary.cleanWindowStartedAt),
  );
  const ready =
    summary.consecutivePassedSamples >= REQUIRED_SAMPLES &&
    summary.lastPassed &&
    summary.maxStateGatewayMs <= MAX_SAMPLE_MS &&
    summary.maxGapMs <= MAX_GAP_MS &&
    durationMs >= REQUIRED_DURATION_MS;
  return Response.json(
    {
      gate: "G3",
      status: ready ? "passed" : "collecting",
      ready,
      durationMs,
      requiredDurationMs: REQUIRED_DURATION_MS,
      requiredSamples: REQUIRED_SAMPLES,
      maxAllowedStateGatewayMs: MAX_SAMPLE_MS,
      maxAllowedGapMs: MAX_GAP_MS,
      ...summary,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
