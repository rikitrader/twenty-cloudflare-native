import { accessIdentityForRequest, type AccessIdentity } from "./access";
import type { Env } from "./types";
import { nativeSessionCookie, nativeSessionExpiresAt } from "./native-auth";
import { crmPermissions } from './crm-records';
import { isCrmImportType, mapImportRecord, previewImportRecords, writeImportRecord, type ImportMapping } from './crm-import';
import { reconcileMigration } from './crm-reconciliation';

type Contact = {
  id: string;
  workspaceId: string;
  firstName: string;
  lastName: string;
  email: string | null;
  customFieldsJson?: string;
  createdAt: string;
  updatedAt: string;
};

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function cleanupExpiredFileUploads(env: Env): Promise<void> {
  if (!env.CRM_DB) return;
  const now = new Date().toISOString();
  const expired = await env.CRM_DB.prepare("SELECT id,object_key as objectKey FROM pending_file_uploads WHERE status IN ('pending','uploading','failed') AND expires_at <= ? LIMIT 100").bind(now).all<{id:string;objectKey:string}>();
  for (const row of expired.results) {
    await env.STORAGE.delete(row.objectKey).catch(() => undefined);
    await env.CRM_DB.prepare("UPDATE pending_file_uploads SET status='expired' WHERE id=? AND status IN ('pending','uploading','failed')").bind(row.id).run();
  }
}

function requestId(request: Request): string {
  const supplied = request.headers.get("x-request-id");
  return supplied && /^[a-zA-Z0-9._:-]{1,128}$/.test(supplied) ? supplied : crypto.randomUUID();
}

async function audit(env: Env, workspaceId: string, actorSubject: string, requestIdValue: string, action: string, objectType: string, objectId: string | null, metadata: Record<string, unknown> = {}): Promise<void> {
  await env.CRM_DB!.prepare(
    "INSERT INTO crm_audit_events (id, workspace_id, actor_subject, action, object_type, object_id, request_id, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(crypto.randomUUID(), workspaceId, actorSubject, action, objectType, objectId, requestIdValue, JSON.stringify(metadata), new Date().toISOString()).run();
}

async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function emitCrmEvent(env: Env, workspaceId: string, actorSubject: string, requestIdValue: string, action: string, objectType: string, objectId: string): Promise<void> {
  const eventId = crypto.randomUUID(); const now = new Date().toISOString();
  const payload = { eventId, workspaceId, actorSubject, requestId: requestIdValue, objectType, objectId, action };
  await env.CRM_DB!.prepare("INSERT INTO crm_event_outbox (event_id, workspace_id, actor_subject, action, object_type, object_id, payload_json, status, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)").bind(eventId, workspaceId, actorSubject, action, objectType, objectId, JSON.stringify(payload), now, now).run();
  try {
    await env.EVENTS_QUEUE.send({ eventId, type: `crm.${action}`, payload: JSON.stringify(payload), receivedAt: now });
    await env.CRM_DB!.prepare("UPDATE crm_event_outbox SET status = 'queued', attempts = attempts + 1, updated_at = ? WHERE event_id = ?").bind(new Date().toISOString(), eventId).run();
  } catch (error) {
    await env.CRM_DB!.prepare("UPDATE crm_event_outbox SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE event_id = ?").bind(String(error).slice(0, 500), new Date().toISOString(), eventId).run();
    console.warn("CRM event enqueue failed", { workspaceId, objectType, objectId, error });
  }
}

async function validOwner(env: Env, workspaceId: string, value: unknown): Promise<string | null> {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 254) return null;
  const member = await env.CRM_DB!.prepare("SELECT 1 FROM workspace_members WHERE workspace_id = ? AND identity_subject = ? AND status = 'active'").bind(workspaceId, value).first();
  return member ? value : null;
}

function validId(value: string | null): value is string {
  return Boolean(value && /^[a-zA-Z0-9_-]{1,128}$/.test(value));
}

async function identity(request: Request, env: Env): Promise<AccessIdentity | null> {
  return accessIdentityForRequest(request, env);
}

async function authorizedWorkspace(
  request: Request,
  env: Env,
): Promise<{ actor: AccessIdentity; workspaceId: string; role: string } | Response> {
  const actor = await identity(request, env);
  if (!actor) return json({ error: "unauthorized" }, 401);
  const workspaceId = request.headers.get("x-workspace-id");
  if (!validId(workspaceId)) return json({ error: "x-workspace-id is required" }, 400);
  if (actor.authenticationType === "api-key") {
    if (actor.workspaceId !== workspaceId || !actor.workspaceRole) return json({ error: "workspace access denied" }, 403);
    return { actor, workspaceId, role: actor.workspaceRole };
  }
  const member = await env.CRM_DB!.prepare(
    "SELECT COALESCE('custom:' || ra.role_id,m.role) AS role FROM workspace_members m LEFT JOIN role_assignments ra ON ra.workspace_id=m.workspace_id AND ra.identity_subject=m.identity_subject WHERE m.workspace_id = ? AND m.identity_subject = ? AND m.status = 'active' LIMIT 1",
  ).bind(workspaceId, actor.subject).first();
  if (!member) return json({ error: "workspace access denied" }, 403);
  return { actor, workspaceId, role: String((member as { role?: unknown }).role ?? "member") };
}

async function permission(env: Env, workspaceId: string, role: string, action: 'read' | 'create' | 'update' | 'delete', objectType?: string): Promise<boolean> {
  return (await crmPermissions(env,workspaceId,role,objectType))[action];
}

function parseContact(body: unknown): { firstName: string; lastName: string; email: string | null } | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  const firstName = typeof value.firstName === "string" ? value.firstName.trim() : "";
  const lastName = typeof value.lastName === "string" ? value.lastName.trim() : "";
  const email = value.email == null ? null : typeof value.email === "string" ? value.email.trim() : "invalid";
  if (!firstName || !lastName || firstName.length > 120 || lastName.length > 120 || email === "invalid" || (email && email.length > 254)) return null;
  return { firstName, lastName, email };
}

async function validateCustomFields(env: Env, workspaceId: string, objectType: string, raw: unknown): Promise<Record<string, unknown> | null> {
  if (raw == null) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const definitions = await env.CRM_DB!.prepare("SELECT field_key as fieldKey, field_type as fieldType, options_json as optionsJson FROM custom_fields WHERE workspace_id = ? AND object_type = ?").bind(workspaceId, objectType).all<{fieldKey: string; fieldType: string; optionsJson: string | null}>();
  const byKey = new Map(definitions.results.map((field) => [field.fieldKey, field]));
  for (const [key, item] of Object.entries(value)) {
    const definition = byKey.get(key);
    if (!definition) return null;
    const valid = definition.fieldType === "text" ? typeof item === "string" && item.length <= 5000
      : definition.fieldType === "number" ? typeof item === "number" && Number.isFinite(item)
      : definition.fieldType === "boolean" ? typeof item === "boolean"
      : definition.fieldType === "date" ? typeof item === "string" && !Number.isNaN(Date.parse(item))
      : definition.fieldType === "select" ? typeof item === "string" && (!definition.optionsJson || (JSON.parse(definition.optionsJson) as unknown[]).includes(item))
      : false;
    if (!valid) return null;
  }
  return value;
}

export async function handleD1Crm(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/crm/") && !url.pathname.startsWith("/api/auth/")) return null;
  if (!env.CRM_DB) return json({ error: "CRM_DB is not configured" }, 503);
  const correlationId = requestId(request);
  if (request.method !== "GET" && request.method !== "HEAD" && request.method !== "OPTIONS") {
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin) return json({ error: "cross-origin request denied", requestId: correlationId }, 403);
  }
  if (url.pathname === "/api/auth/provision" && request.method === "POST") {
    const actor = await accessIdentityForRequest(request, env);
    if (!actor) return json({ error: "unauthorized" }, 401);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) return json({ error: "invalid workspace name" }, 400);
    const workspaceId = crypto.randomUUID(); const now = new Date().toISOString();
    await env.CRM_DB.batch([
      env.CRM_DB.prepare("INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)").bind(workspaceId, name, now),
      env.CRM_DB.prepare("INSERT INTO workspace_members (workspace_id, identity_subject, role, status, created_at) VALUES (?, ?, 'owner', 'active', ?)").bind(workspaceId, actor.subject, now),
    ]);
    return json({ data: { workspaceId, name, role: "owner", createdAt: now } }, 201);
  }
  if (url.pathname === "/api/auth/profile" && (request.method === "GET" || request.method === "PUT")) {
    const actor = await accessIdentityForRequest(request, env);
    if (!actor) return json({ error: "unauthorized" }, 401);
    const workspaceId = request.headers.get("x-workspace-id");
    if (!validId(workspaceId)) return json({ error: "x-workspace-id is required" }, 400);
    const member = await env.CRM_DB.prepare("SELECT role FROM workspace_members WHERE workspace_id = ? AND identity_subject = ? AND status = 'active' LIMIT 1").bind(workspaceId, actor.subject).first();
    if (!member) return json({ error: "workspace access denied" }, 403);
    if (request.method === "GET") {
      const profile = await env.CRM_DB.prepare("SELECT display_name as displayName, locale, notification_preferences_json as notificationPreferencesJson, created_at as createdAt, updated_at as updatedAt FROM voter_profiles WHERE workspace_id = ? AND identity_subject = ?").bind(workspaceId, actor.subject).first<{displayName: string; locale: string; notificationPreferencesJson: string; createdAt: string; updatedAt: string}>();
      return json({ data: { subject: actor.subject, email: actor.email ?? null, displayName: profile?.displayName ?? actor.email?.split("@")[0] ?? "", locale: profile?.locale === "es-VE" ? "es-ES" : profile?.locale ?? "es-ES", notificationPreferences: JSON.parse(profile?.notificationPreferencesJson ?? "{}"), createdAt: profile?.createdAt ?? null, updatedAt: profile?.updatedAt ?? null } });
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const displayName = typeof body?.displayName === "string" ? body.displayName.trim().slice(0, 120) : "";
    const locale = body?.locale === "es" || body?.locale === "es-VE" ? "es-ES" : typeof body?.locale === "string" && /^(?:en-US|es-ES|fr-FR|de-DE|it-IT|pt-BR)$/.test(body.locale) ? body.locale : "es-ES";
    const preferences = body?.notificationPreferences && typeof body.notificationPreferences === "object" && !Array.isArray(body.notificationPreferences) ? body.notificationPreferences : {};
    const now = new Date().toISOString();
    await env.CRM_DB.prepare("INSERT INTO voter_profiles (workspace_id, identity_subject, display_name, locale, notification_preferences_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(workspace_id, identity_subject) DO UPDATE SET display_name = excluded.display_name, locale = excluded.locale, notification_preferences_json = excluded.notification_preferences_json, updated_at = excluded.updated_at").bind(workspaceId, actor.subject, displayName, locale, JSON.stringify(preferences), now, now).run();
    await audit(env, workspaceId, actor.subject, correlationId, "update", "voter_profile", actor.subject, { locale });
    return json({ data: { subject: actor.subject, email: actor.email ?? null, displayName, locale, notificationPreferences: preferences, updatedAt: now } });
  }
  const acceptToken = url.pathname.match(/^\/api\/auth\/invitations\/([a-zA-Z0-9_-]{20,128})$/)?.[1];
  if (acceptToken && request.method === "POST") {
    const actor = await accessIdentityForRequest(request, env);
    if (!actor) return json({ error: "unauthorized" }, 401);
    const hash = await tokenHash(acceptToken); const now = new Date().toISOString();
    const invitation = await env.CRM_DB.prepare("SELECT id, workspace_id as workspaceId, role, status, expires_at as expiresAt FROM workspace_invitations WHERE token_hash = ? LIMIT 1").bind(hash).first<{id: string; workspaceId: string; role: string; status: string; expiresAt: string}>();
    if (!invitation || invitation.status !== "pending" || invitation.expiresAt <= now) return json({ error: "invitation is invalid or expired" }, 400);
    await env.CRM_DB.batch([
      env.CRM_DB.prepare("INSERT INTO workspace_members (workspace_id, identity_subject, role, status, created_at) VALUES (?, ?, ?, 'active', ?) ON CONFLICT(workspace_id, identity_subject) DO UPDATE SET role = excluded.role, status = 'active'").bind(invitation.workspaceId, actor.subject, invitation.role, now),
      env.CRM_DB.prepare("UPDATE workspace_invitations SET status = 'accepted', accepted_at = ? WHERE id = ? AND status = 'pending'").bind(now, invitation.id),
    ]);
    await audit(env, invitation.workspaceId, actor.subject, correlationId, "accept", "workspace_invitation", invitation.id);
    return json({ data: { workspaceId: invitation.workspaceId, role: invitation.role, status: "active" } });
  }
  const directUploadId = url.pathname.match(/^\/api\/crm\/file-uploads\/([a-zA-Z0-9_-]{1,128})$/)?.[1];
  if (directUploadId && request.method === 'PUT') {
    const token = url.searchParams.get('token') ?? '';
    if (token.length < 40 || token.length > 160) return json({ error: 'invalid upload token' }, 401);
    const hash = await tokenHash(token); const now = new Date().toISOString();
    const upload = await env.CRM_DB.prepare("SELECT id,workspace_id as workspaceId,filename,content_type as contentType,expected_bytes as expectedBytes,object_key as objectKey,status,expires_at as expiresAt FROM pending_file_uploads WHERE id = ? AND token_hash = ?")
      .bind(directUploadId, hash).first<{id:string;workspaceId:string;filename:string;contentType:string;expectedBytes:number;objectKey:string;status:string;expiresAt:string}>();
    if (!upload || upload.status !== 'pending' || upload.expiresAt <= now) return json({ error: 'upload target is invalid, expired, or already used' }, 410);
    const declared = Number(request.headers.get('content-length') ?? -1);
    const requestType = (request.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!request.body || (declared >= 0 && declared !== upload.expectedBytes) || (requestType && requestType !== upload.contentType)) return json({ error: 'upload metadata mismatch' }, 400);
    const claim = await env.CRM_DB.prepare("UPDATE pending_file_uploads SET status = 'uploading' WHERE id = ? AND token_hash = ? AND status = 'pending' AND expires_at > ?").bind(upload.id, hash, now).run();
    if (!claim.meta || Number((claim.meta as {changes?:number}).changes ?? 0) !== 1) return json({ error: 'upload target already used' }, 409);
    try {
      const object = await env.STORAGE.put(upload.objectKey, request.body, { httpMetadata: { contentType: upload.contentType }, customMetadata: { workspaceId: upload.workspaceId, fileId: upload.id } });
      if (object.size !== upload.expectedBytes || object.size > 25 * 1024 * 1024) {
        await env.STORAGE.delete(upload.objectKey);
        await env.CRM_DB.prepare("UPDATE pending_file_uploads SET status = 'failed' WHERE id = ? AND status = 'uploading'").bind(upload.id).run();
        return json({ error: 'uploaded size does not match requested size' }, 400);
      }
      await env.CRM_DB.batch([
        env.CRM_DB.prepare('INSERT INTO crm_files (id,workspace_id,object_key,filename,content_type,bytes,created_at) VALUES (?,?,?,?,?,?,?)').bind(upload.id, upload.workspaceId, upload.objectKey, upload.filename, upload.contentType, object.size, now),
        env.CRM_DB.prepare("UPDATE pending_file_uploads SET status = 'uploaded', uploaded_at = ? WHERE id = ? AND status = 'uploading'").bind(now, upload.id),
      ]);
      return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      await env.CRM_DB.prepare("UPDATE pending_file_uploads SET status = 'failed' WHERE id = ? AND status = 'uploading'").bind(upload.id).run();
      console.error('Direct upload failed', { fileId: upload.id, error: String(error) });
      return json({ error: 'upload failed' }, 500);
    }
  }
  const auth = await authorizedWorkspace(request, env);
  if (auth instanceof Response) return auth;
  const { workspaceId } = auth;
  if (env.OPS_RATE_LIMITER) {
    const limited = await env.OPS_RATE_LIMITER.limit({ key: `crm:${workspaceId}:${auth.actor.subject}` });
    if (!limited.success) return json({ error: "rate limit exceeded" }, 429);
  }
  if (url.pathname === "/api/crm/search" && request.method === "GET") {
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
    if (!q) return json({ data: [] });
    const pattern = `%${q}%`;
    const [contacts, companies, opportunities, activities, customRecords] = await env.CRM_DB.batch([
      env.CRM_DB.prepare("SELECT id, 'contact' as objectType, first_name || ' ' || last_name as label, email as detail FROM contacts WHERE workspace_id = ? AND (first_name LIKE ? OR last_name LIKE ? OR email LIKE ?) ORDER BY updated_at DESC LIMIT 25").bind(workspaceId, pattern, pattern, pattern),
      env.CRM_DB.prepare("SELECT id, 'company' as objectType, name as label, domain as detail FROM companies WHERE workspace_id = ? AND (name LIKE ? OR domain LIKE ?) ORDER BY updated_at DESC LIMIT 25").bind(workspaceId, pattern, pattern),
      env.CRM_DB.prepare("SELECT id, 'opportunity' as objectType, name as label, stage as detail FROM opportunities WHERE workspace_id = ? AND (name LIKE ? OR stage LIKE ?) ORDER BY updated_at DESC LIMIT 25").bind(workspaceId, pattern, pattern),
      env.CRM_DB.prepare("SELECT id, 'activity' as objectType, title as label, type as detail FROM activities WHERE workspace_id = ? AND (title LIKE ? OR body LIKE ?) ORDER BY updated_at DESC LIMIT 25").bind(workspaceId, pattern, pattern),
      env.CRM_DB.prepare("SELECT id, 'custom:' || object_key as objectType, id as label, data_json as detail FROM custom_records WHERE workspace_id = ? AND data_json LIKE ? ORDER BY updated_at DESC LIMIT 25").bind(workspaceId, pattern),
    ]);
    return json({ data: contacts.results.concat(companies.results, opportunities.results, activities.results, customRecords.results).slice(0, 100) });
  }
  if (url.pathname === "/api/crm/members" && request.method === "GET") {
    const rows = await env.CRM_DB.prepare("SELECT identity_subject as subject, role, status, created_at as createdAt FROM workspace_members WHERE workspace_id = ? ORDER BY created_at").bind(workspaceId).all();
    return json({ data: rows.results });
  }
  const memberSubjectPath = url.pathname.match(/^\/api\/crm\/members\/(.+)$/)?.[1];
  if (memberSubjectPath && request.method === "PUT") {
    if (auth.role !== "owner" && auth.role !== "admin") return json({ error: "admin access required" }, 403);
    let subject: string;
    try { subject = decodeURIComponent(memberSubjectPath); } catch { return json({ error: "invalid member subject" }, 400); }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const role = body?.role === "owner" || body?.role === "admin" || body?.role === "member" ? body.role : null;
    const status = body?.status === "active" || body?.status === "suspended" ? body.status : null;
    if (!role && !status) return json({ error: "role or status is required" }, 400);
    if (subject === auth.actor.subject && (role === "member" || status === "suspended")) return json({ error: "cannot remove your own administrative access" }, 400);
    const result = await env.CRM_DB.prepare("UPDATE workspace_members SET role = COALESCE(?, role), status = COALESCE(?, status) WHERE workspace_id = ? AND identity_subject = ?").bind(role, status, workspaceId, subject).run();
    if (!result.meta.changes) return json({ error: "member not found" }, 404);
    await audit(env, workspaceId, auth.actor.subject, correlationId, "update", "workspace_member", subject, { role, status });
    return json({ data: { subject, role, status } });
  }
  if (url.pathname === "/api/crm/outbox" && request.method === "GET") {
    if (auth.role !== "owner" && auth.role !== "admin") return json({ error: "admin access required" }, 403);
    const rows = await env.CRM_DB.prepare("SELECT event_id as eventId, action, object_type as objectType, object_id as objectId, status, attempts, last_error as lastError, created_at as createdAt, updated_at as updatedAt FROM crm_event_outbox WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 200").bind(workspaceId).all();
    return json({ data: rows.results });
  }
  const outboxEventId = url.pathname.match(/^\/api\/crm\/outbox\/([a-zA-Z0-9-]{20,128})\/replay$/)?.[1];
  if (outboxEventId && request.method === "POST") {
    if (auth.role !== "owner" && auth.role !== "admin") return json({ error: "admin access required" }, 403);
    const result = await env.CRM_DB.prepare("UPDATE crm_event_outbox SET status = 'pending', last_error = NULL, updated_at = ? WHERE event_id = ? AND workspace_id = ? AND status IN ('failed', 'queued')").bind(new Date().toISOString(), outboxEventId, workspaceId).run();
    if (!result.meta.changes) return json({ error: "event not found or not replayable" }, 404);
    await audit(env, workspaceId, auth.actor.subject, correlationId, "replay", "crm_event", outboxEventId);
    return json({ data: { eventId: outboxEventId, status: "pending" } });
  }
  if (url.pathname === "/api/crm/invitations" && request.method === "GET") {
    if (auth.role !== "owner" && auth.role !== "admin") return json({ error: "admin access required" }, 403);
    const rows = await env.CRM_DB.prepare("SELECT id, email, role, status, expires_at as expiresAt, created_at as createdAt, accepted_at as acceptedAt FROM workspace_invitations WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200").bind(workspaceId).all();
    return json({ data: rows.results });
  }
  if (url.pathname === "/api/crm/invitations" && request.method === "POST") {
    if (auth.role !== "owner" && auth.role !== "admin") return json({ error: "admin access required" }, 403);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    const role = body?.role === "admin" ? "admin" : body?.role === "member" || body?.role == null ? "member" : null;
    if (!role || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json({ error: "invalid invitation" }, 400);
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`; const now = new Date(); const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); const id = crypto.randomUUID();
    await env.CRM_DB.prepare("INSERT INTO workspace_invitations (id, workspace_id, email, role, token_hash, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)").bind(id, workspaceId, email, role, await tokenHash(token), expires.toISOString(), now.toISOString()).run();
    await audit(env, workspaceId, auth.actor.subject, correlationId, "create", "workspace_invitation", id, { email, role });
    return json({ data: { id, email, role, expiresAt: expires.toISOString(), token } }, 201);
  }
  const companyIdPath = url.pathname.match(/^\/api\/crm\/companies\/([a-zA-Z0-9_-]{1,128})$/)?.[1];
  if (companyIdPath && (request.method === "PUT" || request.method === "DELETE")) {
    if (request.method === "DELETE") {
      const result = await env.CRM_DB.prepare("DELETE FROM companies WHERE id = ? AND workspace_id = ?").bind(companyIdPath, workspaceId).run();
      return result.meta.changes ? json({ deleted: true }) : json({ error: "not found" }, 404);
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 200) return json({ error: "invalid company" }, 400);
    const customFields = await validateCustomFields(env, workspaceId, "company", body?.customFields);
    if (!customFields) return json({ error: "invalid custom fields" }, 400);
    const ownerSubject = await validOwner(env, workspaceId, body?.ownerSubject);
    if (body?.ownerSubject != null && body.ownerSubject !== "" && !ownerSubject) return json({ error: "owner must be an active workspace member" }, 400);
    const now = new Date().toISOString();
    const result = await env.CRM_DB.prepare("UPDATE companies SET name = ?, domain = ?, custom_fields_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?").bind(name, typeof body?.domain === "string" ? body.domain.slice(0, 254) : null, JSON.stringify(customFields), now, companyIdPath, workspaceId).run();
    return result.meta.changes ? json({ data: { id: companyIdPath, workspaceId, name, customFields, updatedAt: now } }) : json({ error: "not found" }, 404);
  }
  const opportunityIdPath = url.pathname.match(/^\/api\/crm\/opportunities\/([a-zA-Z0-9_-]{1,128})$/)?.[1];
  if (opportunityIdPath && (request.method === "PUT" || request.method === "DELETE")) {
    if (request.method === "DELETE") {
      const result = await env.CRM_DB.prepare("DELETE FROM opportunities WHERE id = ? AND workspace_id = ?").bind(opportunityIdPath, workspaceId).run();
      return result.meta.changes ? json({ deleted: true }) : json({ error: "not found" }, 404);
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name.trim() : ""; const stage = typeof body?.stage === "string" ? body.stage.trim() : "prospecting";
    if (!name || name.length > 200 || !stage || stage.length > 80) return json({ error: "invalid opportunity" }, 400);
    const customFields = await validateCustomFields(env, workspaceId, "opportunity", body?.customFields);
    if (!customFields) return json({ error: "invalid custom fields" }, 400);
    const now = new Date().toISOString();
    const result = await env.CRM_DB.prepare("UPDATE opportunities SET name = ?, amount_cents = ?, stage = ?, custom_fields_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?").bind(name, Number.isSafeInteger(body?.amountCents) ? body?.amountCents : null, stage, JSON.stringify(customFields), now, opportunityIdPath, workspaceId).run();
    return result.meta.changes ? json({ data: { id: opportunityIdPath, workspaceId, name, stage, customFields, updatedAt: now } }) : json({ error: "not found" }, 404);
  }
  const pipelineId = url.pathname.match(/^\/api\/crm\/pipelines\/([a-zA-Z0-9_-]{1,128})$/)?.[1];
  if (pipelineId && (request.method === "PUT" || request.method === "DELETE")) {
    if (request.method === "DELETE") {
      const result = await env.CRM_DB.prepare("DELETE FROM pipelines WHERE id = ? AND workspace_id = ?").bind(pipelineId, workspaceId).run();
      return result.meta.changes ? json({ deleted: true }) : json({ error: "not found" }, 404);
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) return json({ error: "invalid pipeline" }, 400);
    const result = await env.CRM_DB.prepare("UPDATE pipelines SET name = ? WHERE id = ? AND workspace_id = ?").bind(name, pipelineId, workspaceId).run();
    return result.meta.changes ? json({ data: { id: pipelineId, workspaceId, name } }) : json({ error: "not found" }, 404);
  }
  const activityId = url.pathname.match(/^\/api\/crm\/activities\/([a-zA-Z0-9_-]{1,128})$/)?.[1];
  if (activityId && (request.method === "PUT" || request.method === "DELETE")) {
    if (request.method === "DELETE") {
      const result = await env.CRM_DB.prepare("DELETE FROM activities WHERE id = ? AND workspace_id = ?").bind(activityId, workspaceId).run();
      return result.meta.changes ? json({ deleted: true }) : json({ error: "not found" }, 404);
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const completedAt = body?.completedAt == null ? null : typeof body.completedAt === "string" ? body.completedAt : "invalid";
    if (!title || title.length > 240 || completedAt === "invalid") return json({ error: "invalid activity" }, 400);
    const now = new Date().toISOString();
    const result = await env.CRM_DB.prepare("UPDATE activities SET title = ?, body = ?, due_at = ?, completed_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?").bind(title, typeof body?.body === "string" ? body.body.slice(0, 10000) : null, typeof body?.dueAt === "string" ? body.dueAt : null, completedAt, now, activityId, workspaceId).run();
    return result.meta.changes ? json({ data: { id: activityId, workspaceId, title, completedAt, updatedAt: now } }) : json({ error: "not found" }, 404);
  }
  if (url.pathname === "/api/crm/export" && request.method === "POST") {
    if (auth.role !== "owner" && auth.role !== "admin") return json({ error: "admin access required" }, 403);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const requested = typeof body.objectType === "string" ? body.objectType : "all";
    if (!/^(all|contact|company|pipeline|opportunity|activity|task|taskTarget|note|noteTarget|attachment|file|fileLink|relationship|customObject|customField|customRecord|view)$/.test(requested)) return json({ error: "invalid objectType" }, 400);
    if (!env.CRM_EXPORT_WF) return json({ error: "CRM_EXPORT_WF is not configured" }, 503);
    const id = crypto.randomUUID();
    const instance = await env.CRM_EXPORT_WF.create({ params: { workspaceId, objectType: requested, exportId: id } });
    const now = new Date().toISOString();
    await env.CRM_DB.prepare("INSERT INTO crm_exports (id, workspace_id, workflow_id, object_type, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)").bind(id, workspaceId, instance.id, requested, now, now).run();
    return json({ data: { id, workflowId: instance.id, objectType: requested, status: "queued" } }, 202);
  }
  const exportIdPath = url.pathname.match(/^\/api\/crm\/exports\/([a-zA-Z0-9_-]{1,128})$/)?.[1];
  if (exportIdPath && request.method === "GET") {
    const row = await env.CRM_DB.prepare("SELECT id, workflow_id as workflowId, object_type as objectType, status, object_key as objectKey, bytes, error, created_at as createdAt, updated_at as updatedAt FROM crm_exports WHERE id = ? AND workspace_id = ?").bind(exportIdPath, workspaceId).first();
    return row ? json({ data: row }) : json({ error: "export not found" }, 404);
  }
  const exportAction=url.pathname.match(/^\/api\/crm\/exports\/([a-zA-Z0-9_-]{1,128})\/(cancel|resume|download)$/);
  if(exportAction){
    if(auth.role!=="owner"&&auth.role!=="admin")return json({error:'admin access required'},403);
    const [,id,action]=exportAction;const row=await env.CRM_DB.prepare('SELECT * FROM crm_exports WHERE id=? AND workspace_id=?').bind(id,workspaceId).first<Record<string,any>>();if(!row)return json({error:'export not found'},404);
    if(action==='cancel'&&request.method==='POST'){const now=new Date().toISOString();const changed=await env.CRM_DB.prepare("UPDATE crm_exports SET status='cancelled',cancelled_at=?,updated_at=? WHERE id=? AND workspace_id=? AND status IN ('queued','running')").bind(now,now,id,workspaceId).run();if(Number(changed.meta?.changes??0)!==1)return json({error:'only queued or running exports can be cancelled'},409);return json({data:{id,status:'cancelled'}});}
    if(action==='resume'&&request.method==='POST'){if(!env.CRM_EXPORT_WF)return json({error:'CRM_EXPORT_WF is not configured'},503);if(!['failed','cancelled'].includes(String(row.status)))return json({error:'only failed or cancelled exports can resume'},409);const instance=await env.CRM_EXPORT_WF.create({params:{workspaceId,objectType:String(row.object_type),exportId:id}});const now=new Date().toISOString();await env.CRM_DB.prepare("UPDATE crm_exports SET workflow_id=?,status='queued',error=NULL,cancelled_at=NULL,updated_at=? WHERE id=? AND workspace_id=?").bind(instance.id,now,id,workspaceId).run();return json({data:{id,workflowId:instance.id,status:'queued'}},202);}
    if(action==='download'&&request.method==='GET'){if(row.status!=='complete'||!row.object_key)return json({error:'export is not ready'},409);const object=await env.STORAGE.get(String(row.object_key));if(!object)return json({error:'export object missing'},410);const ndjson=String(row.object_key).endsWith('.ndjson');return new Response(object.body,{headers:{'content-type':ndjson?'application/x-ndjson':'application/json','content-disposition':`attachment; filename="twenty-export-${id}.${ndjson?'ndjson':'json'}"`,'cache-control':'private, no-store'}});}
    return json({error:'method not allowed'},405);
  }
  if(url.pathname==='/api/crm/imports/upload'&&request.method==='POST'){
    if(auth.role!=='owner'&&auth.role!=='admin')return json({error:'admin access required'},403);
    if(!env.CRM_IMPORT_WF)return json({error:'CRM_IMPORT_WF is not configured'},503);
    const objectType=request.headers.get('x-object-type')??'';if(!isCrmImportType(objectType))return json({error:'unsupported x-object-type'},400);
    let mapping:ImportMapping={};const mappingHeader=request.headers.get('x-import-mapping');if(mappingHeader){if(mappingHeader.length>8192)return json({error:'import mapping is too large'},431);try{const parsed=JSON.parse(mappingHeader);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.entries(parsed).some(([source,target])=>source.length>128||typeof target!=='string'||target.length>128))throw new Error();mapping=parsed;}catch{return json({error:'x-import-mapping must be a JSON object'},400);}}
    const contentType=(request.headers.get('content-type')??'').split(';')[0].trim();if(!['application/x-ndjson','application/ndjson'].includes(contentType))return json({error:'large imports require NDJSON'},415);
    const declared=Number(request.headers.get('content-length')??-1);if(declared===0||declared>250*1024*1024)return json({error:'import must be between 1 byte and 250 MiB'},413);if(!request.body)return json({error:'import body required'},400);
    const id=crypto.randomUUID(),key=`imports/${workspaceId}/${id}/source.ndjson`,now=new Date().toISOString();
    const stored=await env.STORAGE.put(key,request.body,{httpMetadata:{contentType:'application/x-ndjson'},customMetadata:{workspaceId,importId:id,objectType}});if(stored.size<1||stored.size>250*1024*1024){await env.STORAGE.delete(key);return json({error:'import must be between 1 byte and 250 MiB'},413);}
    await env.CRM_DB.prepare("INSERT INTO migration_runs (id,workspace_id,status,cursor,processed,failed,total,mapping_json,object_key,object_type,bytes,source_etag,created_at,updated_at) VALUES (?,?,'pending','0',0,0,NULL,?,?,?,?,?,?,?)").bind(id,workspaceId,JSON.stringify(mapping),key,objectType,stored.size,stored.etag,now,now).run();
    try{const instance=await env.CRM_IMPORT_WF.create({params:{workspaceId,importId:id}});await env.CRM_DB.prepare('UPDATE migration_runs SET workflow_id=?,updated_at=? WHERE id=? AND workspace_id=?').bind(instance.id,new Date().toISOString(),id,workspaceId).run();return json({data:{id,workflowId:instance.id,status:'pending',objectType,bytes:stored.size}},202);}catch(error){await env.CRM_DB.prepare("UPDATE migration_runs SET status='failed',error=?,updated_at=? WHERE id=? AND workspace_id=?").bind(String(error).slice(0,500),new Date().toISOString(),id,workspaceId).run();return json({error:'import workflow could not be started',id},503);}
  }
  if(url.pathname==='/api/crm/imports/preview'&&request.method==='POST'){
    if(auth.role!=='owner'&&auth.role!=='admin')return json({error:'admin access required'},403);
    const body=await request.json().catch(()=>null) as Record<string,unknown>|null;const objectType=body?.objectType;if(!isCrmImportType(objectType))return json({error:'unsupported objectType'},400);const records=Array.isArray(body?.records)?body.records:[];if(records.length<1||records.length>50||records.some(record=>!record||typeof record!=='object'||Array.isArray(record)))return json({error:'records must contain 1 to 50 objects'},400);const mapping=body?.mapping&&typeof body.mapping==='object'&&!Array.isArray(body.mapping)?body.mapping as ImportMapping:{};
    try{return json({data:await previewImportRecords(env,workspaceId,objectType,records as Record<string,unknown>[],mapping)});}catch(error){return json({error:String(error instanceof Error?error.message:error).slice(0,200)},400);}
  }
  if(url.pathname==='/api/crm/reconciliation'&&request.method==='POST'){
    if(auth.role!=='owner'&&auth.role!=='admin')return json({error:'admin access required'},403);const body=await request.json().catch(()=>null) as Record<string,unknown>|null;try{return json({data:await reconcileMigration(env,workspaceId,body?.sourceManifestSha256,body?.expectedCounts)});}catch(error){return json({error:String(error instanceof Error?error.message:error).slice(0,300)},400);}
  }
  if(url.pathname==='/api/crm/migration-files/upload'&&request.method==='POST'){
    if(auth.role!=='owner'&&auth.role!=='admin')return json({error:'admin access required'},403);const key=request.headers.get('x-object-key')??'',filename=request.headers.get('x-file-name')??'',declared=Number(request.headers.get('content-length')??-1),contentType=(request.headers.get('content-type')??'application/octet-stream').split(';')[0];if(!key.startsWith(`migrations/${workspaceId}/`)||key.length>1024||!filename||filename.length>255||declared<1||declared>250*1024*1024||!request.body)return json({error:'invalid migration file upload'},400);const stored=await env.STORAGE.put(key,request.body,{httpMetadata:{contentType},customMetadata:{workspaceId,filename,migration:'postgres'}});if(stored.size!==declared){await env.STORAGE.delete(key);return json({error:'uploaded byte count does not match content-length'},409);}return json({data:{objectKey:key,bytes:stored.size,etag:stored.etag}},201);
  }
  if (url.pathname === "/api/crm/import" && request.method === "POST") {
    if (auth.role !== "owner" && auth.role !== "admin") return json({ error: "admin access required" }, 403);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const objectType = typeof body?.objectType === "string" ? body.objectType : "";
    const records = Array.isArray(body?.records) ? body.records : [];
    if (!isCrmImportType(objectType) || records.length > 100 || records.some((record) => !record || typeof record !== "object" || Array.isArray(record))) return json({ error: "invalid import batch" }, 400);
    const now = new Date().toISOString(); const runId = validId(typeof body?.runId === "string" ? body.runId : null) ? String(body?.runId) : crypto.randomUUID();
    const cursor = typeof body?.cursor === "string" ? body.cursor.slice(0, 256) : null;
    const existingRun=await env.CRM_DB.prepare('SELECT status FROM migration_runs WHERE id=? AND workspace_id=?').bind(runId,workspaceId).first<{status:string}>();if(existingRun?.status==='cancelled'&&body?.resume!==true)return json({error:'import is cancelled; resume it explicitly'},409);
    const mapping=body?.mapping&&typeof body.mapping==='object'&&!Array.isArray(body.mapping)?body.mapping:{};const total=Number.isInteger(body?.total)&&Number(body?.total)>=0?Number(body?.total):null;
    await env.CRM_DB.prepare("INSERT INTO migration_runs (id, workspace_id, status, cursor, processed, failed,total,mapping_json, created_at, updated_at) VALUES (?, ?, 'running', ?, 0, 0,?,?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = 'running', cursor = excluded.cursor,total=COALESCE(excluded.total,migration_runs.total),mapping_json=excluded.mapping_json,cancelled_at=NULL, updated_at = excluded.updated_at").bind(runId, workspaceId, cursor,total,JSON.stringify(mapping), now, now).run();
    let processed = 0,failed=0;const errors:{index:number;message:string}[]=[];
    for (const [recordIndex,raw] of (records as Record<string, unknown>[]).entries()) {
      try {
        await writeImportRecord(env,workspaceId,objectType,mapImportRecord(objectType,raw,mapping as ImportMapping),now);
        processed++;
      } catch(error) {failed++;errors.push({index:recordIndex,message:error instanceof Error?error.message.slice(0,200):'record failed'});}
    }
    const done = body?.done === true;
    let errorKey:string|null=null;if(errors.length){errorKey=`imports/${workspaceId}/${runId}/errors-${Date.now()}.json`;await env.STORAGE.put(errorKey,JSON.stringify({runId,cursor,errors}),{httpMetadata:{contentType:'application/json'},customMetadata:{workspaceId,runId}});}
    await env.CRM_DB.prepare("UPDATE migration_runs SET status = ?, cursor = ?, processed = processed + ?,failed=failed+?,error_object_key=COALESCE(?,error_object_key), updated_at = ? WHERE id = ? AND workspace_id = ? AND status!='cancelled'").bind(done ? "completed" : "running", cursor, processed,failed,errorKey, now, runId, workspaceId).run();
    return json({ data: { runId, status: done ? "completed" : "running", processed,failed, cursor,errorObjectKey:errorKey } });
  }
  const importStatusId = url.pathname.match(/^\/api\/crm\/import\/([a-zA-Z0-9_-]{1,128})$/)?.[1];
  if (importStatusId && request.method === "GET") {
    const run = await env.CRM_DB.prepare("SELECT id, status, cursor, processed, failed,total,mapping_json as mapping,error_object_key as errorObjectKey,error,object_type as objectType,bytes,workflow_id as workflowId, cancelled_at as cancelledAt,created_at as createdAt, updated_at as updatedAt FROM migration_runs WHERE id = ? AND workspace_id = ?").bind(importStatusId, workspaceId).first();
    return run ? json({ data: run }) : json({ error: "migration run not found" }, 404);
  }
  const importAction=url.pathname.match(/^\/api\/crm\/import\/([a-zA-Z0-9_-]{1,128})\/(cancel|resume|errors)$/);
  if(importAction){if(auth.role!=="owner"&&auth.role!=="admin")return json({error:'admin access required'},403);const[,id,action]=importAction;const row=await env.CRM_DB.prepare('SELECT * FROM migration_runs WHERE id=? AND workspace_id=?').bind(id,workspaceId).first<Record<string,any>>();if(!row)return json({error:'migration run not found'},404);if(action==='cancel'&&request.method==='POST'){const now=new Date().toISOString();await env.CRM_DB.prepare("UPDATE migration_runs SET status='cancelled',cancelled_at=?,updated_at=? WHERE id=? AND workspace_id=? AND status IN ('pending','running')").bind(now,now,id,workspaceId).run();return json({data:{id,status:'cancelled',cursor:row.cursor}});}if(action==='resume'&&request.method==='POST'){if(!['cancelled','failed'].includes(String(row.status)))return json({error:'only cancelled or failed imports can resume'},409);if(row.object_key){if(!env.CRM_IMPORT_WF)return json({error:'CRM_IMPORT_WF is not configured'},503);const now=new Date().toISOString();await env.CRM_DB.prepare("UPDATE migration_runs SET status='pending',cancelled_at=NULL,error=NULL,updated_at=? WHERE id=? AND workspace_id=?").bind(now,id,workspaceId).run();try{const instance=await env.CRM_IMPORT_WF.create({params:{workspaceId,importId:id}});await env.CRM_DB.prepare('UPDATE migration_runs SET workflow_id=?,updated_at=? WHERE id=? AND workspace_id=?').bind(instance.id,new Date().toISOString(),id,workspaceId).run();return json({data:{id,workflowId:instance.id,status:'pending',cursor:row.cursor}},202);}catch(error){await env.CRM_DB.prepare("UPDATE migration_runs SET status='failed',error=?,updated_at=? WHERE id=? AND workspace_id=?").bind(String(error).slice(0,500),new Date().toISOString(),id,workspaceId).run();return json({error:'import workflow could not be resumed'},503);}}await env.CRM_DB.prepare("UPDATE migration_runs SET status='pending',cancelled_at=NULL,error=NULL,updated_at=? WHERE id=? AND workspace_id=?").bind(new Date().toISOString(),id,workspaceId).run();return json({data:{id,status:'pending',cursor:row.cursor}});}if(action==='errors'&&request.method==='GET'){if(!row.error_object_key)return json({error:'no error artifact'},404);const object=await env.STORAGE.get(String(row.error_object_key));if(!object)return json({error:'error artifact missing'},410);return new Response(object.body,{headers:{'content-type':'application/json','content-disposition':`attachment; filename="import-errors-${id}.json"`,'cache-control':'private, no-store'}});}return json({error:'method not allowed'},405);}
  const fileMatch = url.pathname.match(/^\/api\/crm\/files(?:\/([a-zA-Z0-9_-]{1,128}))?$/);
  if (fileMatch && request.method === "GET" && !fileMatch[1]) {
    if (!(await permission(env, workspaceId, auth.role, 'read','attachment'))) return json({ error: 'read access denied' }, 403);
    const rows = await env.CRM_DB.prepare("SELECT id, filename, content_type as contentType, bytes, created_at as createdAt FROM crm_files WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 100").bind(workspaceId).all();
    return json({ data: rows.results });
  }
  if (fileMatch && request.method === "POST" && !fileMatch[1]) {
    if (!(await permission(env, workspaceId, auth.role, 'create','attachment'))) return json({ error: 'create access denied' }, 403);
    const filename = (request.headers.get("x-file-name") ?? "upload.bin").trim().slice(0, 255);
    const contentType = (request.headers.get("content-type") ?? "application/octet-stream").split(";")[0].trim();
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (!filename || !/^[\w .()\-]+$/.test(filename) || !/^[-\w.+]+\/[\w.+-]+$/.test(contentType) || declared < 0 || declared > 25 * 1024 * 1024) return json({ error: "invalid upload" }, 400);
    const id = crypto.randomUUID(); const key = `crm/${workspaceId}/${id}/${filename}`; const body = request.body;
    if (!body) return json({ error: "upload body required" }, 400);
    const object = await env.STORAGE.put(key, body, { httpMetadata: { contentType }, customMetadata: { workspaceId, fileId: id } });
    const bytes = object.size;
    if (bytes > 25 * 1024 * 1024) { await env.STORAGE.delete(key); return json({ error: "file too large" }, 413); }
    const now = new Date().toISOString();
    await env.CRM_DB.prepare("INSERT INTO crm_files (id, workspace_id, object_key, filename, content_type, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, workspaceId, key, filename, contentType, bytes, now).run();
    const recordType = request.headers.get("x-record-type"); const recordId = request.headers.get("x-record-id");
    if (recordType && validId(recordId) && /^(contact|company|opportunity|activity)$/.test(recordType)) {
      const table = recordType === "contact" ? "contacts" : recordType === "company" ? "companies" : recordType === "opportunity" ? "opportunities" : "activities";
      const exists = await env.CRM_DB.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND workspace_id = ?`).bind(recordId, workspaceId).first();
      if (exists) await env.CRM_DB.prepare("INSERT INTO crm_file_links (file_id, workspace_id, record_type, record_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, workspaceId, recordType, recordId, now).run();
    }
    return json({ data: { id, filename, contentType, bytes, createdAt: now } }, 201);
  }
  if (url.pathname === "/api/crm/file-links" && request.method === "GET") {
    const recordType = url.searchParams.get("recordType"); const recordId = url.searchParams.get("recordId");
    if (!recordType || !/^(contact|company|opportunity|activity)$/.test(recordType) || !validId(recordId)) return json({ error: "invalid record" }, 400);
    if (!(await permission(env, workspaceId, auth.role, 'read',recordType==='contact'?'person':recordType))) return json({ error: 'read access denied' }, 403);
    const rows = await env.CRM_DB.prepare("SELECT f.id, f.filename, f.content_type as contentType, f.bytes, f.created_at as createdAt FROM crm_files f JOIN crm_file_links l ON l.file_id = f.id WHERE l.workspace_id = ? AND l.record_type = ? AND l.record_id = ? ORDER BY f.created_at DESC").bind(workspaceId, recordType, recordId).all();
    return json({ data: rows.results });
  }
  if (url.pathname === "/api/crm/file-links" && request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const fileId = typeof body?.fileId === 'string' ? body.fileId : null; const recordType = typeof body?.recordType === 'string' ? body.recordType : ''; const recordId = typeof body?.recordId === 'string' ? body.recordId : null;
    if (!validId(fileId) || !validId(recordId) || !/^(contact|company|opportunity|activity|custom:[a-z][a-z0-9_]{0,63})$/.test(recordType)) return json({ error: 'invalid file link' }, 400);
    const permissionObject=recordType==='contact'?'person':recordType.startsWith('custom:')?recordType.slice(7):recordType;if (!(await permission(env, workspaceId, auth.role, 'update',permissionObject))) return json({ error: 'update access denied' }, 403);
    const file = await env.CRM_DB.prepare('SELECT 1 FROM crm_files WHERE workspace_id=? AND id=?').bind(workspaceId, fileId).first();
    const record = recordType.startsWith('custom:')
      ? await env.CRM_DB.prepare('SELECT 1 FROM custom_records WHERE workspace_id=? AND object_key=? AND id=? AND deleted_at IS NULL').bind(workspaceId, recordType.slice(7), recordId).first()
      : await env.CRM_DB.prepare(`SELECT 1 FROM ${recordType === 'contact' ? 'contacts' : recordType === 'company' ? 'companies' : recordType === 'opportunity' ? 'opportunities' : 'activities'} WHERE workspace_id=? AND id=? AND deleted_at IS NULL`).bind(workspaceId, recordId).first();
    if (!file || !record) return json({ error: 'file or record not found' }, 404);
    const now = new Date().toISOString();
    await env.CRM_DB.prepare('INSERT OR IGNORE INTO crm_file_links (file_id,workspace_id,record_type,record_id,created_at) VALUES (?,?,?,?,?)').bind(fileId, workspaceId, recordType, recordId, now).run();
    await audit(env, workspaceId, auth.actor.subject, correlationId, 'link', 'file', fileId, { recordType, recordId });
    return json({ data: { fileId, recordType, recordId, createdAt: now } }, 201);
  }
  const fileLinkId = url.pathname.match(/^\/api\/crm\/file-links\/([a-zA-Z0-9_-]{1,128})$/)?.[1];
  if (fileLinkId && request.method === 'DELETE') {
    const recordType = url.searchParams.get('recordType') ?? ''; const recordId = url.searchParams.get('recordId');
    if (!validId(recordId) || !/^(contact|company|opportunity|activity|custom:[a-z][a-z0-9_]{0,63})$/.test(recordType)) return json({ error: 'invalid file link' }, 400);
    const permissionObject=recordType==='contact'?'person':recordType.startsWith('custom:')?recordType.slice(7):recordType;if (!(await permission(env, workspaceId, auth.role, 'update',permissionObject))) return json({ error: 'update access denied' }, 403);
    const result = await env.CRM_DB.prepare('DELETE FROM crm_file_links WHERE workspace_id=? AND file_id=? AND record_type=? AND record_id=?').bind(workspaceId, fileLinkId, recordType, recordId).run();
    if (Number(result.meta?.changes ?? 0) !== 1) return json({ error: 'file link not found' }, 404);
    await audit(env, workspaceId, auth.actor.subject, correlationId, 'unlink', 'file', fileLinkId, { recordType, recordId });
    return new Response(null, { status: 204 });
  }
  if (fileMatch?.[1] && request.method === "GET") {
    if (!(await permission(env, workspaceId, auth.role, 'read','attachment'))) return json({ error: 'read access denied' }, 403);
    const row = await env.CRM_DB.prepare("SELECT object_key as objectKey, filename, content_type as contentType FROM crm_files WHERE id = ? AND workspace_id = ?").bind(fileMatch[1], workspaceId).first<{objectKey: string; filename: string; contentType: string}>();
    if (!row) return json({ error: "file not found" }, 404);
    const object = await env.STORAGE.get(row.objectKey);
    if (!object) return json({ error: "file not found" }, 404);
    return new Response(object.body, { headers: { "content-type": row.contentType, "content-disposition": `attachment; filename="${row.filename.replace(/"/g, "")}"`, "cache-control": "private, no-store" } });
  }
  if (fileMatch?.[1] && request.method === 'DELETE') {
    if (!(await permission(env, workspaceId, auth.role, 'delete','attachment'))) return json({ error: 'delete access denied' }, 403);
    const row = await env.CRM_DB.prepare('SELECT object_key as objectKey FROM crm_files WHERE id=? AND workspace_id=?').bind(fileMatch[1], workspaceId).first<{objectKey:string}>();
    if (!row) return json({ error: 'file not found' }, 404);
    await env.STORAGE.delete(row.objectKey);
    await env.CRM_DB.prepare('DELETE FROM crm_files WHERE id=? AND workspace_id=?').bind(fileMatch[1], workspaceId).run();
    await audit(env, workspaceId, auth.actor.subject, correlationId, 'delete', 'file', fileMatch[1]);
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/api/auth/me" && request.method === "GET") {
    const now = new Date().toISOString();
    const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)twenty_session=([^;]+)/)?.[1];
    if (cookie && validId(cookie)) {
      await env.CRM_DB.prepare("UPDATE native_sessions SET last_seen_at = ? WHERE id = ? AND workspace_id = ? AND identity_subject = ? AND revoked_at IS NULL AND expires_at > ?").bind(now, cookie, workspaceId, auth.actor.subject, now).run();
    }
    return json({ data: { subject: auth.actor.subject, email: auth.actor.email ?? null, workspaceId, session: cookie ?? null } });
  }
  if (url.pathname === "/api/auth/session" && request.method === "POST") {
    const now = new Date(); const id = crypto.randomUUID(); const expires = nativeSessionExpiresAt(now);
    await env.CRM_DB.prepare("INSERT INTO native_sessions (id, workspace_id, identity_subject, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, workspaceId, auth.actor.subject, now.toISOString(), now.toISOString(), expires).run();
    return new Response(JSON.stringify({ data: { session: id, expiresAt: expires } }), { status: 201, headers: { "content-type": "application/json", "cache-control": "no-store", "set-cookie": nativeSessionCookie(id) } });
  }
  if (url.pathname === "/api/auth/logout" && request.method === "POST") {
    const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)twenty_session=([^;]+)/)?.[1];
    if (cookie && validId(cookie)) await env.CRM_DB.prepare("UPDATE native_sessions SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND identity_subject = ?").bind(new Date().toISOString(), cookie, workspaceId, auth.actor.subject).run();
    return new Response(JSON.stringify({ loggedOut: true }), { headers: { "content-type": "application/json", "set-cookie": "twenty_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0" } });
  }
  if (url.pathname === "/api/crm/relationships" && request.method === "GET") {
    const sourceType = url.searchParams.get("sourceType"); const sourceId = url.searchParams.get("sourceId");
    if (!sourceType || !validId(sourceId) || !/^(contact|company|opportunity|activity|custom:[a-z][a-z0-9_]{1,63})$/.test(sourceType)) return json({ error: "invalid source" }, 400);
    const rows = await env.CRM_DB.prepare("SELECT id, source_type as sourceType, source_id as sourceId, target_type as targetType, target_id as targetId, relation_key as relationKey, created_at as createdAt FROM record_relationships WHERE workspace_id = ? AND ((source_type = ? AND source_id = ?) OR (target_type = ? AND target_id = ?)) ORDER BY created_at DESC LIMIT 200").bind(workspaceId, sourceType, sourceId, sourceType, sourceId).all();
    return json({ data: rows.results });
  }
  if (url.pathname === "/api/crm/relationships" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const sourceType = typeof body?.sourceType === "string" ? body.sourceType : ""; const targetType = typeof body?.targetType === "string" ? body.targetType : "";
    const sourceId = typeof body?.sourceId === "string" ? body.sourceId : null; const targetId = typeof body?.targetId === "string" ? body.targetId : null;
    const relationKey = typeof body?.relationKey === "string" ? body.relationKey.trim() : "related";
    const validType = /^(contact|company|opportunity|activity|custom:[a-z][a-z0-9_]{1,63})$/;
    if (!validType.test(sourceType) || !validType.test(targetType) || !validId(sourceId) || !validId(targetId) || !/^[a-z][a-z0-9_-]{0,63}$/.test(relationKey)) return json({ error: "invalid relationship" }, 400);
    const exists = async (type: string, id: string) => type.startsWith("custom:")
      ? env.CRM_DB!.prepare("SELECT 1 FROM custom_records WHERE workspace_id = ? AND object_key = ? AND id = ?").bind(workspaceId, type.slice(7), id).first()
      : env.CRM_DB!.prepare(`SELECT 1 FROM ${type === "contact" ? "contacts" : type === "company" ? "companies" : type === "opportunity" ? "opportunities" : "activities"} WHERE workspace_id = ? AND id = ?`).bind(workspaceId, id).first();
    if (!(await exists(sourceType, sourceId)) || !(await exists(targetType, targetId))) return json({ error: "related record not found" }, 400);
    const now = new Date().toISOString(); const id = crypto.randomUUID();
    try { await env.CRM_DB.prepare("INSERT INTO record_relationships (id, workspace_id, source_type, source_id, target_type, target_id, relation_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, workspaceId, sourceType, sourceId, targetType, targetId, relationKey, now).run(); }
    catch { return json({ error: "relationship already exists" }, 409); }
    return json({ data: { id, workspaceId, sourceType, sourceId, targetType, targetId, relationKey, createdAt: now } }, 201);
  }
  const customObjectMatch = url.pathname.match(/^\/api\/crm\/custom-objects\/([a-z][a-z0-9_]{1,63})(?:\/records(?:\/([a-zA-Z0-9_-]{1,128}))?)?$/);
  if (url.pathname === "/api/crm/custom-objects" && request.method === "GET") {
    const rows = await env.CRM_DB.prepare("SELECT id, object_key as objectKey, label, plural_label as pluralLabel, created_at as createdAt, updated_at as updatedAt FROM custom_objects WHERE workspace_id = ? ORDER BY label LIMIT 200").bind(workspaceId).all();
    return json({ data: rows.results });
  }
  if (url.pathname === "/api/crm/custom-objects" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const objectKey = typeof body?.objectKey === "string" ? body.objectKey.trim() : "";
    const label = typeof body?.label === "string" ? body.label.trim() : "";
    const pluralLabel = typeof body?.pluralLabel === "string" ? body.pluralLabel.trim() : label;
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(objectKey) || !label || label.length > 120 || !pluralLabel || pluralLabel.length > 120) return json({ error: "invalid custom object" }, 400);
    const now = new Date().toISOString(); const id = crypto.randomUUID();
    try { await env.CRM_DB.prepare("INSERT INTO custom_objects (id, workspace_id, object_key, label, plural_label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(id, workspaceId, objectKey, label, pluralLabel, now, now).run(); }
    catch { return json({ error: "object key already exists" }, 409); }
    return json({ data: { id, workspaceId, objectKey, label, pluralLabel, createdAt: now, updatedAt: now } }, 201);
  }
  if (customObjectMatch?.[0].includes("/records")) {
    const objectKey = customObjectMatch[1];
    const recordId = customObjectMatch[2];
    const object = await env.CRM_DB.prepare("SELECT 1 FROM custom_objects WHERE workspace_id = ? AND object_key = ?").bind(workspaceId, objectKey).first();
    if (!object) return json({ error: "custom object not found" }, 404);
    if (recordId && (request.method === "PUT" || request.method === "DELETE")) {
      if (request.method === "DELETE") {
        const result = await env.CRM_DB.prepare("DELETE FROM custom_records WHERE id = ? AND workspace_id = ? AND object_key = ?").bind(recordId, workspaceId, objectKey).run();
        return result.meta.changes ? json({ deleted: true }) : json({ error: "not found" }, 404);
      }
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "record must be an object" }, 400);
      const now = new Date().toISOString();
      const result = await env.CRM_DB.prepare("UPDATE custom_records SET data_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ? AND object_key = ?").bind(JSON.stringify(body), now, recordId, workspaceId, objectKey).run();
      return result.meta.changes ? json({ data: { id: recordId, ...(body as Record<string, unknown>), updatedAt: now } }) : json({ error: "not found" }, 404);
    }
    if (recordId && request.method === "GET") {
      const row = await env.CRM_DB.prepare("SELECT id, data_json as dataJson, created_at as createdAt, updated_at as updatedAt FROM custom_records WHERE id = ? AND workspace_id = ? AND object_key = ?").bind(recordId, workspaceId, objectKey).first();
      if (!row) return json({ error: "not found" }, 404);
      return json({ data: { id: (row as Record<string, unknown>).id, ...JSON.parse(String((row as Record<string, unknown>).dataJson ?? "{}")), createdAt: (row as Record<string, unknown>).createdAt, updatedAt: (row as Record<string, unknown>).updatedAt } });
    }
    if (request.method === "GET") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 100); const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0); const q = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
      const rows = await env.CRM_DB.prepare("SELECT id, data_json as dataJson, created_at as createdAt, updated_at as updatedAt FROM custom_records WHERE workspace_id = ? AND object_key = ? AND (? = '' OR data_json LIKE ?) ORDER BY updated_at DESC LIMIT ? OFFSET ?").bind(workspaceId, objectKey, q, `%${q}%`, limit, offset).all();
      return json({ data: rows.results.map((row) => ({ id: (row as Record<string, unknown>).id, ...(JSON.parse(String((row as Record<string, unknown>).dataJson ?? "{}"))), createdAt: (row as Record<string, unknown>).createdAt, updatedAt: (row as Record<string, unknown>).updatedAt })), pageInfo: { limit, offset, hasNextPage: rows.results.length === limit } });
    }
    if (request.method === "POST") {
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "record must be an object" }, 400);
      const now = new Date().toISOString(); const id = crypto.randomUUID();
      await env.CRM_DB.prepare("INSERT INTO custom_records (id, workspace_id, object_key, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, workspaceId, objectKey, JSON.stringify(body), now, now).run();
      return json({ data: { id, ...(body as Record<string, unknown>), createdAt: now, updatedAt: now } }, 201);
    }
    return json({ error: "method not allowed" }, 405);
  }
  if (url.pathname === "/api/crm/metadata/fields" && request.method === "GET") {
    const objectType = url.searchParams.get("objectType");
    if (!objectType || !/^(contact|company|opportunity|activity)$/.test(objectType)) return json({ error: "invalid objectType" }, 400);
    const rows = await env.CRM_DB.prepare("SELECT id, object_type as objectType, field_key as fieldKey, label, field_type as fieldType, options_json as optionsJson, created_at as createdAt FROM custom_fields WHERE workspace_id = ? AND object_type = ? ORDER BY label LIMIT 200").bind(workspaceId, objectType).all();
    return json({ data: rows.results });
  }
  if (url.pathname === "/api/crm/metadata/fields" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const objectType = typeof body?.objectType === "string" ? body.objectType : "";
    const fieldKey = typeof body?.fieldKey === "string" ? body.fieldKey.trim() : "";
    const label = typeof body?.label === "string" ? body.label.trim() : "";
    const fieldType = typeof body?.fieldType === "string" ? body.fieldType : "";
    if (!/^(contact|company|opportunity|activity)$/.test(objectType) || !/^[a-z][a-z0-9_]{1,63}$/.test(fieldKey) || !label || label.length > 120 || !/^(text|number|boolean|date|select)$/.test(fieldType)) return json({ error: "invalid custom field" }, 400);
    const now = new Date().toISOString(); const id = crypto.randomUUID();
    const optionsJson = Array.isArray(body?.options) ? JSON.stringify(body.options.slice(0, 100)) : null;
    try { await env.CRM_DB.prepare("INSERT INTO custom_fields (id, workspace_id, object_type, field_key, label, field_type, options_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, workspaceId, objectType, fieldKey, label, fieldType, optionsJson, now).run(); }
    catch { return json({ error: "field key already exists" }, 409); }
    return json({ data: { id, workspaceId, objectType, fieldKey, label, fieldType, options: optionsJson ? JSON.parse(optionsJson) : null, createdAt: now } }, 201);
  }
  if (url.pathname === "/api/crm/views" && request.method === "GET") {
    const objectType = url.searchParams.get("objectType") ?? "contact";
    const rows = await env.CRM_DB.prepare("SELECT id, object_type as objectType, name, filters_json as filtersJson, sort_json as sortJson, created_at as createdAt, updated_at as updatedAt FROM saved_views WHERE workspace_id = ? AND object_type = ? ORDER BY updated_at DESC LIMIT 100").bind(workspaceId, objectType).all();
    return json({ data: rows.results });
  }
  if (url.pathname === "/api/crm/views" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const objectType = typeof body?.objectType === "string" ? body.objectType : "contact";
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!/^(contact|company|opportunity|activity)$/.test(objectType) || !name || name.length > 120 || (body?.filters != null && !Array.isArray(body.filters))) return json({ error: "invalid view" }, 400);
    const now = new Date().toISOString(); const id = crypto.randomUUID();
    await env.CRM_DB.prepare("INSERT INTO saved_views (id, workspace_id, object_type, name, filters_json, sort_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, workspaceId, objectType, name, JSON.stringify(body?.filters ?? []), body?.sort ? JSON.stringify(body.sort) : null, now, now).run();
    return json({ data: { id, workspaceId, objectType, name, filters: body?.filters ?? [], sort: body?.sort ?? null, createdAt: now, updatedAt: now } }, 201);
  }
  if (url.pathname === "/api/crm/pipelines" && request.method === "GET") {
    const rows = await env.CRM_DB.prepare("SELECT id, workspace_id as workspaceId, name, created_at as createdAt FROM pipelines WHERE workspace_id = ? ORDER BY name LIMIT 100").bind(workspaceId).all();
    return json({ data: rows.results });
  }
  if (url.pathname === "/api/crm/pipelines" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) return json({ error: "invalid pipeline" }, 400);
    const now = new Date().toISOString(); const id = crypto.randomUUID();
    await env.CRM_DB.prepare("INSERT INTO pipelines (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)").bind(id, workspaceId, name, now).run();
    await audit(env, workspaceId, auth.actor.subject, correlationId, "create", "pipeline", id);
    await emitCrmEvent(env, workspaceId, auth.actor.subject, correlationId, "created", "pipeline", id);
    return json({ data: { id, workspaceId, name, createdAt: now } }, 201);
  }
  if (url.pathname === "/api/crm/activities" && request.method === "GET") {
    const rows = await env.CRM_DB.prepare("SELECT id, workspace_id as workspaceId, type, title, body, contact_id as contactId, company_id as companyId, opportunity_id as opportunityId, due_at as dueAt, completed_at as completedAt, custom_fields_json as customFieldsJson, owner_subject as ownerSubject, created_at as createdAt, updated_at as updatedAt FROM activities WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 100").bind(workspaceId).all();
    return json({ data: rows.results.map((row) => ({ ...row, customFields: JSON.parse(String((row as Record<string, unknown>).customFieldsJson ?? "{}")) })) });
  }
  if (url.pathname === "/api/crm/activities" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const type = typeof body?.type === "string" ? body.type : "";
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    const activityTypes = new Set(["note", "task", "call", "email"]);
    if (!activityTypes.has(type) || !title || title.length > 240) return json({ error: "invalid activity" }, 400);
    const customFields = await validateCustomFields(env, workspaceId, "activity", body?.customFields);
    if (!customFields) return json({ error: "invalid custom fields" }, 400);
    const contactId = validId(typeof body?.contactId === "string" ? body.contactId : null) ? body?.contactId : null;
    const companyId = validId(typeof body?.companyId === "string" ? body.companyId : null) ? body?.companyId : null;
    const opportunityId = validId(typeof body?.opportunityId === "string" ? body.opportunityId : null) ? body?.opportunityId : null;
    const refs = await env.CRM_DB.batch([
      env.CRM_DB.prepare("SELECT 1 FROM contacts WHERE id = ? AND workspace_id = ?").bind(contactId, workspaceId),
      env.CRM_DB.prepare("SELECT 1 FROM companies WHERE id = ? AND workspace_id = ?").bind(companyId, workspaceId),
      env.CRM_DB.prepare("SELECT 1 FROM opportunities WHERE id = ? AND workspace_id = ?").bind(opportunityId, workspaceId),
    ]);
    if ((contactId && !refs[0].results.length) || (companyId && !refs[1].results.length) || (opportunityId && !refs[2].results.length)) return json({ error: "related record not found" }, 400);
    const ownerSubject = await validOwner(env, workspaceId, body?.ownerSubject);
    if (body?.ownerSubject != null && body.ownerSubject !== "" && !ownerSubject) return json({ error: "owner must be an active workspace member" }, 400);
    const now = new Date().toISOString(); const id = crypto.randomUUID();
    const activityBody = typeof body?.body === "string" ? body.body.slice(0, 10000) : null;
    const dueAt = typeof body?.dueAt === "string" ? body.dueAt : null;
    await env.CRM_DB.prepare("INSERT INTO activities (id, workspace_id, type, title, body, contact_id, company_id, opportunity_id, due_at, custom_fields_json, owner_subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, workspaceId, type, title, activityBody, contactId, companyId, opportunityId, dueAt, JSON.stringify(customFields), ownerSubject, now, now).run();
    await audit(env, workspaceId, auth.actor.subject, correlationId, "create", "activity", id);
    await emitCrmEvent(env, workspaceId, auth.actor.subject, correlationId, "created", "activity", id);
    return json({ data: { id, workspaceId, type, title, body: activityBody, contactId, companyId, opportunityId, dueAt, customFields, completedAt: null, createdAt: now, updatedAt: now } }, 201);
  }
  if (url.pathname === "/api/crm/companies" && request.method === "GET") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 100);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
    const rows = await env.CRM_DB.prepare(
      "SELECT id, workspace_id as workspaceId, name, domain, custom_fields_json as customFieldsJson, owner_subject as ownerSubject, created_at as createdAt, updated_at as updatedAt FROM companies WHERE workspace_id = ? AND (? = '' OR name LIKE ? OR domain LIKE ?) ORDER BY updated_at DESC LIMIT ? OFFSET ?",
    ).bind(workspaceId, q, `%${q}%`, `%${q}%`, limit, offset).all();
    return json({ data: rows.results.map((row) => ({ ...row, customFields: JSON.parse(String((row as Record<string, unknown>).customFieldsJson ?? "{}")) })), pageInfo: { limit, offset, hasNextPage: rows.results.length === limit } });
  }
  if (url.pathname === "/api/crm/companies" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const domain = body?.domain == null ? null : typeof body.domain === "string" ? body.domain.trim() : "invalid";
    if (!name || name.length > 200 || domain === "invalid" || (domain && domain.length > 254)) return json({ error: "invalid company" }, 400);
    const customFields = await validateCustomFields(env, workspaceId, "company", body?.customFields);
    if (!customFields) return json({ error: "invalid custom fields" }, 400);
    const ownerSubject = await validOwner(env, workspaceId, body?.ownerSubject);
    if (body?.ownerSubject != null && body.ownerSubject !== "" && !ownerSubject) return json({ error: "owner must be an active workspace member" }, 400);
    const now = new Date().toISOString(); const id = crypto.randomUUID();
    await env.CRM_DB.prepare("INSERT INTO companies (id, workspace_id, name, domain, custom_fields_json, owner_subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, workspaceId, name, domain, JSON.stringify(customFields), ownerSubject, now, now).run();
    await audit(env, workspaceId, auth.actor.subject, correlationId, "create", "company", id);
    await emitCrmEvent(env, workspaceId, auth.actor.subject, correlationId, "created", "company", id);
    return json({ data: { id, workspaceId, name, domain, customFields, createdAt: now, updatedAt: now } }, 201);
  }
  if (url.pathname === "/api/crm/opportunities" && request.method === "GET") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 100);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
    const rows = await env.CRM_DB.prepare(
      "SELECT id, workspace_id as workspaceId, name, amount_cents as amountCents, stage, company_id as companyId, point_of_contact_id as pointOfContactId, pipeline_id as pipelineId, custom_fields_json as customFieldsJson, owner_subject as ownerSubject, created_at as createdAt, updated_at as updatedAt FROM opportunities WHERE workspace_id = ? AND (? = '' OR name LIKE ? OR stage LIKE ?) ORDER BY updated_at DESC LIMIT ? OFFSET ?",
    ).bind(workspaceId, q, `%${q}%`, `%${q}%`, limit, offset).all();
    return json({ data: rows.results.map((row) => ({ ...row, customFields: JSON.parse(String((row as Record<string, unknown>).customFieldsJson ?? "{}")) })), pageInfo: { limit, offset, hasNextPage: rows.results.length === limit } });
  }
  if (url.pathname === "/api/crm/opportunities" && request.method === "POST") {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const stage = typeof body?.stage === "string" ? body.stage.trim() : "prospecting";
    const amountCents = body?.amountCents == null ? null : Number(body.amountCents);
    if (!name || name.length > 200 || !stage || stage.length > 80 || (amountCents !== null && (!Number.isSafeInteger(amountCents) || amountCents < 0))) return json({ error: "invalid opportunity" }, 400);
    const customFields = await validateCustomFields(env, workspaceId, "opportunity", body?.customFields);
    if (!customFields) return json({ error: "invalid custom fields" }, 400);
    const ownerSubject = await validOwner(env, workspaceId, body?.ownerSubject);
    if (body?.ownerSubject != null && body.ownerSubject !== "" && !ownerSubject) return json({ error: "owner must be an active workspace member" }, 400);
    const companyId = validId(typeof body?.companyId === "string" ? body.companyId : null) ? body?.companyId : null;
    const pointOfContactId = validId(typeof body?.pointOfContactId === "string" ? body.pointOfContactId : null) ? body?.pointOfContactId : null;
    const pipelineId = validId(typeof body?.pipelineId === "string" ? body.pipelineId : null) ? body?.pipelineId : null;
    const refs = await env.CRM_DB.batch([
      env.CRM_DB.prepare("SELECT 1 FROM companies WHERE id = ? AND workspace_id = ?").bind(companyId, workspaceId),
      env.CRM_DB.prepare("SELECT 1 FROM contacts WHERE id = ? AND workspace_id = ?").bind(pointOfContactId, workspaceId),
      env.CRM_DB.prepare("SELECT 1 FROM pipelines WHERE id = ? AND workspace_id = ?").bind(pipelineId, workspaceId),
    ]);
    if ((companyId && !refs[0].results.length) || (pointOfContactId && !refs[1].results.length) || (pipelineId && !refs[2].results.length)) return json({ error: "related record not found" }, 400);
    const now = new Date().toISOString(); const id = crypto.randomUUID();
    await env.CRM_DB.prepare("INSERT INTO opportunities (id, workspace_id, name, amount_cents, stage, company_id, point_of_contact_id, pipeline_id, custom_fields_json, owner_subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, workspaceId, name, amountCents, stage, companyId, pointOfContactId, pipelineId, JSON.stringify(customFields), ownerSubject, now, now).run();
    await audit(env, workspaceId, auth.actor.subject, correlationId, "create", "opportunity", id);
    await emitCrmEvent(env, workspaceId, auth.actor.subject, correlationId, "created", "opportunity", id);
    return json({ data: { id, workspaceId, name, amountCents, stage, companyId, pointOfContactId, pipelineId, customFields, createdAt: now, updatedAt: now } }, 201);
  }
  const contactId = url.pathname === "/api/crm/contacts" ? null : url.pathname.split("/").pop();

  if (request.method === "GET" && url.pathname === "/api/crm/contacts") {
    const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 100);
    const offset = Math.max(Number(url.searchParams.get("offset") ?? 0) || 0, 0);
    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
    const rows = await env.CRM_DB.prepare(
      "SELECT id, workspace_id as workspaceId, first_name as firstName, last_name as lastName, email, custom_fields_json as customFieldsJson, owner_subject as ownerSubject, created_at as createdAt, updated_at as updatedAt FROM contacts WHERE workspace_id = ? AND (? = '' OR first_name LIKE ? OR last_name LIKE ? OR email LIKE ?) ORDER BY updated_at DESC LIMIT ? OFFSET ?",
    ).bind(workspaceId, q, `%${q}%`, `%${q}%`, `%${q}%`, limit, offset).all<Contact>();
    return json({ data: rows.results.map((row) => ({ ...row, customFields: JSON.parse(row.customFieldsJson ?? "{}") })), pageInfo: { limit, offset, hasNextPage: rows.results.length === limit } });
  }

  if (request.method === "POST" && url.pathname === "/api/crm/contacts") {
    const input = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const parsed = parseContact(input);
    if (!parsed) return json({ error: "invalid contact" }, 400);
    const customFields = await validateCustomFields(env, workspaceId, "contact", input?.customFields);
    if (!customFields) return json({ error: "invalid custom fields" }, 400);
    const ownerSubject = await validOwner(env, workspaceId, input?.ownerSubject);
    if (input?.ownerSubject != null && input.ownerSubject !== "" && !ownerSubject) return json({ error: "owner must be an active workspace member" }, 400);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    await env.CRM_DB.prepare(
      "INSERT INTO contacts (id, workspace_id, first_name, last_name, email, custom_fields_json, owner_subject, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, workspaceId, parsed.firstName, parsed.lastName, parsed.email, JSON.stringify(customFields), ownerSubject, now, now).run();
    await audit(env, workspaceId, auth.actor.subject, correlationId, "create", "contact", id);
    await emitCrmEvent(env, workspaceId, auth.actor.subject, correlationId, "created", "contact", id);
    return json({ data: { id, workspaceId, ...parsed, customFields, ownerSubject, createdAt: now, updatedAt: now } }, 201);
  }

  if (!contactId || !validId(contactId)) return json({ error: "invalid contact id" }, 400);
  if (request.method === "DELETE") {
    const result = await env.CRM_DB.prepare("DELETE FROM contacts WHERE id = ? AND workspace_id = ?").bind(contactId, workspaceId).run();
    return result.meta.changes === 0 ? json({ error: "not found" }, 404) : json({ deleted: true });
  }
  if (request.method === "PUT") {
    const input = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const parsed = parseContact(input);
    if (!parsed) return json({ error: "invalid contact" }, 400);
    const customFields = await validateCustomFields(env, workspaceId, "contact", input?.customFields);
    if (!customFields) return json({ error: "invalid custom fields" }, 400);
    const now = new Date().toISOString();
    const result = await env.CRM_DB.prepare(
      "UPDATE contacts SET first_name = ?, last_name = ?, email = ?, custom_fields_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
    ).bind(parsed.firstName, parsed.lastName, parsed.email, JSON.stringify(customFields), now, contactId, workspaceId).run();
    if (result.meta.changes === 0) return json({ error: "not found" }, 404);
    return json({ data: { id: contactId, workspaceId, ...parsed, customFields, updatedAt: now } });
  }
  return json({ error: "method not allowed" }, 405);
}
