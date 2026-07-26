interface ProbeEnv {
  STAGING: Fetcher;
  PROBE_TOKEN?: string;
  OPS_TOKEN?: string;
  ACCESS_SERVICE_CLIENT_ID?: string;
  ACCESS_SERVICE_CLIENT_SECRET?: string;
}

const TARGET_ORIGIN =
  "https://twenty-crm-enterprise-staging.rikitrader.workers.dev";
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
    const websocket =
      url.pathname === "/realtime" &&
      request.method === "GET" &&
      request.headers.get("upgrade")?.toLowerCase() === "websocket";
    if (!websocket && (url.pathname !== "/probe" || request.method !== "POST"))
      return Response.json({ error: "not found" }, { status: 404 });
    if (!authorized(request, env.PROBE_TOKEN))
      return Response.json({ error: "unauthorized" }, { status: 401 });
    if (
      !env.OPS_TOKEN ||
      !env.ACCESS_SERVICE_CLIENT_ID ||
      !env.ACCESS_SERVICE_CLIENT_SECRET
    )
      return Response.json({ error: "probe unavailable" }, { status: 503 });

    if (websocket) {
      const channel = url.searchParams.get("channel");
      const after = url.searchParams.get("after");
      if (
        !channel ||
        channel.length > 256 ||
        !after ||
        !/^\d+$/.test(after)
      )
        return Response.json(
          { error: "invalid realtime cursor" },
          { status: 400 },
        );
      const target = new URL("/_canary/realtime", TARGET_ORIGIN);
      target.searchParams.set("channel", channel);
      target.searchParams.set("after", after);
      return env.STAGING.fetch(target, {
        headers: {
          upgrade: "websocket",
        },
      });
    }

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
    const canary = target.pathname.startsWith("/_canary/");
    const operations =
      target.pathname === "/_ops/job-failures" ||
      target.pathname === "/_ops/job-failures/summary" ||
      target.pathname === "/_ops/job-failures/bulk-replay" ||
      /^\/_ops\/job-failures\/[^/]+(?:\/(?:replay|dismiss))?$/.test(
        target.pathname,
      );
    const status =
      input.method === "GET" && target.pathname === "/_status";
    if (
      target.origin !== TARGET_ORIGIN ||
      (!canary && !operations && !status)
    )
      return Response.json({ error: "target denied" }, { status: 403 });

    const mutation = input.method === "POST";
    const fetcher = canary ? env.STAGING.fetch.bind(env.STAGING) : fetch;
    const response = await fetcher(target, {
      method: input.method,
      headers: {
        ...(!canary
          ? {
              authorization: `Bearer ${env.OPS_TOKEN}`,
              "cf-access-client-id": env.ACCESS_SERVICE_CLIENT_ID,
              "cf-access-client-secret": env.ACCESS_SERVICE_CLIENT_SECRET,
            }
          : {}),
        ...(mutation
          ? {
              "content-type": "application/json",
              ...(operations
                ? { "x-ops-actor": "enterprise-staging-service" }
                : {}),
            }
          : {}),
      },
      ...(mutation ? { body: JSON.stringify(input.body ?? {}) } : {}),
      redirect: "manual",
      signal: AbortSignal.timeout(
        target.pathname === "/_canary/load/server" ? 180_000 : 30_000,
      ),
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
