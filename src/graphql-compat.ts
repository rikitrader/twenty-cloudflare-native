import { accessIdentityForRequest } from "./access";
import type { Env } from "./types";

/** Small GraphQL compatibility surface for the upstream Twenty frontend. */
export async function handleGraphql(request: Request, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/graphql" || request.method !== "POST") return null;
  const actor = await accessIdentityForRequest(request, env);
  if (!actor || !env.CRM_DB) return Response.json({ errors: [{ message: "unauthorized" }] }, { status: 401 });
  const body = (await request.json().catch(() => ({}))) as { query?: string; operationName?: string; variables?: Record<string, unknown> };
  const operation = body.operationName || body.query?.match(/\b(?:query|mutation)\s+([A-Za-z0-9_]+)/)?.[1] || "";
  if (operation === "IntrospectionQuery") return Response.json({ data: { __schema: { queryType: { name: "Query" }, mutationType: { name: "Mutation" }, types: [] } } });
  const workspaceId = request.headers.get("x-workspace-id") || String(body.variables?.workspaceId || "");
  if (!workspaceId) return Response.json({ errors: [{ message: "x-workspace-id required" }] }, { status: 400 });
  const member = await env.CRM_DB.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND identity_subject = ? AND status = 'active'").bind(workspaceId, actor.subject).first<{ role: string }>();
  if (!member) return Response.json({ errors: [{ message: "forbidden" }] }, { status: 403 });
  const variables = body.variables ?? {};
  const entity = operation.match(/(?:People|Person)/) ? "contacts" : operation.match(/Companies|Company/) ? "companies" : operation.match(/Opportunities|Opportunity/) ? "opportunities" : operation.match(/Activities|Activity/) ? "activities" : null;
  if (!entity) return Response.json({ data: {} });
  if (/^FindMany|^GetMany|^FindAll/.test(operation)) {
    const limit = Math.min(100, Math.max(1, Number(variables.limit ?? variables.first ?? 25)));
    const offset = Math.max(0, Number(variables.offset ?? variables.skip ?? 0));
    const rows = await env.CRM_DB.prepare(`SELECT * FROM ${entity} WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(workspaceId, limit, offset).all<Record<string, unknown>>();
    const key = entity === "contacts" ? "people" : entity;
    return Response.json({ data: { [key]: { edges: rows.results.map((node) => ({ node, cursor: String(node.id ?? "") })), nodes: rows.results, pageInfo: { hasNextPage: rows.results.length === limit, hasPreviousPage: offset > 0, startCursor: rows.results[0]?.id ?? null, endCursor: rows.results.at(-1)?.id ?? null }, totalCount: rows.results.length } } });
  }
  if (/^FindOne/.test(operation)) {
    const id = String(variables.id ?? variables.idToFind ?? variables.recordId ?? "");
    const row = await env.CRM_DB.prepare(`SELECT * FROM ${entity} WHERE workspace_id = ? AND id = ?`).bind(workspaceId, id).first();
    const key = entity === "contacts" ? "person" : entity.slice(0, -1);
    return Response.json({ data: { [key]: row } });
  }
  return Response.json({ data: {} });
}
