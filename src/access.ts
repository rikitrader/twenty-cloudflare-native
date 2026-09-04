import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";
import type { Env } from "./types";

export interface AccessIdentity {
  actor: string;
  subject: string;
  email?: string;
  groups?: string[];
}

export interface AccessConfig {
  audience: string;
  issuer: string;
  allowedGroups?: ReadonlySet<string>;
}

const remoteKeySets = new Map<string, JWTVerifyGetKey>();

function accessConfig(env: Env): AccessConfig | null {
  if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return null;
  try {
    const url = new URL(env.ACCESS_TEAM_DOMAIN);
    if (url.protocol !== "https:" || url.pathname !== "/") return null;
    const allowedGroups = new Set(
      (env.ACCESS_ALLOWED_GROUPS ?? "")
        .split(",")
        .map((group) => group.trim())
        .filter(Boolean),
    );
    return {
      audience: env.ACCESS_AUD,
      issuer: url.origin,
      ...(allowedGroups.size > 0 ? { allowedGroups } : {}),
    };
  } catch {
    return null;
  }
}

function keysFor(issuer: string): JWTVerifyGetKey {
  let keys = remoteKeySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(
      new URL("/cdn-cgi/access/certs", `${issuer}/`),
    );
    remoteKeySets.set(issuer, keys);
  }
  return keys;
}

function identityFromPayload(
  payload: JWTPayload,
  allowedGroups?: ReadonlySet<string>,
): AccessIdentity | null {
  if (payload.type !== "app" || typeof payload.sub !== "string") return null;
  const groups = Array.isArray(payload.groups)
    ? payload.groups.filter(
        (group): group is string =>
          typeof group === "string" && group.length > 0 && group.length <= 256,
      )
    : [];
  if (
    allowedGroups &&
    !groups.some((group) => allowedGroups.has(group))
  )
    return null;
  const email =
    typeof payload.email === "string" && payload.email.length <= 254
      ? payload.email
      : undefined;
  const commonName =
    typeof payload.common_name === "string" &&
    payload.common_name.length <= 128
      ? payload.common_name
      : undefined;
  if (payload.sub.length === 0) {
    if (!commonName?.endsWith(".access")) return null;
    return {
      actor: commonName,
      subject: `service:${commonName}`,
      ...(groups.length > 0 ? { groups } : {}),
    };
  }
  const actor = email ?? commonName ?? payload.sub;
  if (actor.length > 254) return null;
  return {
    actor,
    subject: payload.sub,
    ...(email ? { email } : {}),
    ...(groups.length > 0 ? { groups } : {}),
  };
}

export async function verifyAccessToken(
  token: string,
  config: AccessConfig,
  key: Parameters<typeof jwtVerify>[1] = keysFor(config.issuer),
): Promise<AccessIdentity | null> {
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub"],
      clockTolerance: 5,
    });
    return identityFromPayload(payload, config.allowedGroups);
  } catch {
    return null;
  }
}

export async function accessIdentityForRequest(
  request: Request,
  env: Env,
): Promise<AccessIdentity | null> {
  // A Redis-free deployment is an enterprise production mode. It must never
  // silently fall back to the legacy bearer-only operations boundary when the
  // Access application is missing or misconfigured.
  if (env.ACCESS_REQUIRED !== "true") {
    return env.OPS_TOKEN
      ? {
          actor: "legacy-ops-token",
          subject: "legacy-ops-token",
        }
      : null;
  }
  const config = accessConfig(env);
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!config || !token) return null;
  return verifyAccessToken(token, config);
}
