import type { Env } from "./types";

const REVOCATION_NAMESPACE = "auth-revocation";
const REVOCATION_SHARD = "global";
const MAX_REVOCATION_TTL_MS = 365 * 24 * 60 * 60_000;

interface JwtClaims {
  exp?: unknown;
  jti?: unknown;
}

function bearerToken(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token.length > 0 && token.length <= 8192 ? token : null;
}

function claimsFor(token: string): JwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
    const claims = JSON.parse(atob(padded)) as unknown;
    if (!claims || typeof claims !== "object") return null;
    return claims as JwtClaims;
  } catch {
    return null;
  }
}

async function revocationKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  const fingerprint = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${fingerprint}`;
}

async function stateRequest(
  env: Env,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = env.STATE_DO.idFromName(REVOCATION_SHARD);
  const stub = env.STATE_DO.get(id);
  const input = { namespace: REVOCATION_NAMESPACE, ...body };
  if (path.endsWith("/state/set"))
    return (await stub.setValue(input as never)) as unknown as Record<string, unknown>;
  if (path.endsWith("/state/get"))
    return (await stub.getValue(input as never)) as unknown as Record<string, unknown>;
  throw new Error(`unsupported auth revocation state path: ${path}`);
}

export function hasRevocableClaims(token: string): boolean {
  const claims = claimsFor(token);
  return claims !== null;
}

export async function revokeAccessToken(
  request: Request,
  env: Env,
): Promise<Response> {
  const token = bearerToken(request);
  const claims = token ? claimsFor(token) : null;
  if (!token || !claims)
    return Response.json({ error: "unauthorized" }, { status: 401 });
  const expMs = typeof claims.exp === "number" ? claims.exp * 1000 : Date.now();
  const ttlMs = Math.max(
    1_000,
    Math.min(MAX_REVOCATION_TTL_MS, expMs - Date.now()),
  );
  await stateRequest(env, "/v1/state/set", {
    key: await revocationKey(token),
    value: { revokedAt: new Date().toISOString() },
    ttlMs,
  });
  return Response.json({ revoked: true }, { headers: { "cache-control": "no-store" } });
}

export async function accessTokenRevoked(
  request: Request,
  env: Env,
): Promise<boolean> {
  const token = bearerToken(request);
  if (!token) return false;
  const claims = claimsFor(token);
  if (!claims) return false;
  const result = await stateRequest(env, "/v1/state/get", {
    key: await revocationKey(token),
  });
  return result.found === true;
}

export function authBearerToken(request: Request): string | null {
  return bearerToken(request);
}
