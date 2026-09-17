import type { Env } from "./types";

type HealthResult = {
  status: "ok" | "unavailable";
  database: "ok" | "unavailable";
  runtime: "cloudflare-d1";
  versionId: string | null;
};

/**
 * A readiness probe must exercise the authoritative store.  A successful
 * static-asset response only proves that the Worker bundle loaded; it does not
 * prove that authenticated CRM requests can reach D1.
 */
export async function healthResponse(env: Env): Promise<Response> {
  const headers = {
    "content-type": "application/json",
    "cache-control": "no-store, max-age=0",
  };

  try {
    if (!env.CRM_DB) throw new Error("CRM_DB binding is unavailable");
    const row = await env.CRM_DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    if (row?.ok !== 1) throw new Error("D1 readiness query returned an unexpected result");

    const body: HealthResult = {
      status: "ok",
      database: "ok",
      runtime: "cloudflare-d1",
      versionId: env.CF_VERSION_METADATA?.id ?? null,
    };
    return new Response(JSON.stringify(body), { status: 200, headers });
  } catch {
    const body: HealthResult = {
      status: "unavailable",
      database: "unavailable",
      runtime: "cloudflare-d1",
      versionId: env.CF_VERSION_METADATA?.id ?? null,
    };
    return new Response(JSON.stringify(body), { status: 503, headers });
  }
}
