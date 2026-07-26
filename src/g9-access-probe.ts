interface ProbeEnv {
  PROBE_TOKEN?: string;
  OPS_TOKEN?: string;
  ACCESS_SERVICE_CLIENT_ID?: string;
  ACCESS_SERVICE_CLIENT_SECRET?: string;
}

const TARGET_ORIGIN =
  "https://twenty-crm-redis-free-canary.rikitrader.workers.dev";
const MAX_BODY_BYTES = 64 * 1024;

function authorized(request: Request, token: string | undefined): boolean {
  const header = request.headers.get("authorization");
  return Boolean(
    token &&
      header?.startsWith("Bearer ") &&
      header.slice("Bearer ".length) === token,
  );
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/probe" || request.method !== "POST")
      return Response.json({ error: "not found" }, { status: 404 });
    if (!authorized(request, env.PROBE_TOKEN))
      return Response.json({ error: "unauthorized" }, { status: 401 });
    if (
      !env.OPS_TOKEN ||
      !env.ACCESS_SERVICE_CLIENT_ID ||
      !env.ACCESS_SERVICE_CLIENT_SECRET
    )
      return Response.json({ error: "probe unavailable" }, { status: 503 });

    const text = await request.text();
    if (text.length === 0 || text.length > MAX_BODY_BYTES)
      return Response.json({ error: "invalid body" }, { status: 400 });
    let input: { path?: unknown; method?: unknown; body?: unknown };
    try {
      input = JSON.parse(text) as typeof input;
    } catch {
      return Response.json({ error: "invalid JSON" }, { status: 400 });
    }
    if (
      typeof input.path !== "string" ||
      typeof input.method !== "string" ||
      !["GET", "POST"].includes(input.method)
    )
      return Response.json({ error: "invalid request" }, { status: 400 });

    const target = new URL(input.path, TARGET_ORIGIN);
    const listOrSummary =
      input.method === "GET" &&
      (target.pathname === "/_ops/job-failures" ||
        target.pathname === "/_ops/job-failures/summary" ||
        /^\/_ops\/job-failures\/[^/]+$/.test(target.pathname));
    const operatorAction =
      input.method === "POST" &&
      (target.pathname === "/_ops/job-failures/bulk-replay" ||
        /^\/_ops\/job-failures\/[^/]+\/(replay|dismiss)$/.test(
          target.pathname,
        ));
    if (
      target.origin !== TARGET_ORIGIN ||
      (!listOrSummary && !operatorAction)
    )
      return Response.json({ error: "target denied" }, { status: 403 });

    const response = await fetch(target, {
      method: input.method,
      headers: {
        authorization: `Bearer ${env.OPS_TOKEN}`,
        "cf-access-client-id": env.ACCESS_SERVICE_CLIENT_ID,
        "cf-access-client-secret": env.ACCESS_SERVICE_CLIENT_SECRET,
        ...(operatorAction
          ? {
              "content-type": "application/json",
              "x-ops-actor": "g9-canary-service",
            }
          : {}),
      },
      ...(operatorAction ? { body: JSON.stringify(input.body ?? {}) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    return new Response(response.body, {
      status: response.status,
      headers: {
        "cache-control": "no-store",
        "content-type":
          response.headers.get("content-type") ?? "application/json",
      },
    });
  },
};
