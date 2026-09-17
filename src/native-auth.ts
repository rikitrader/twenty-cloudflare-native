import type { Env } from "./types";

// Workers WebCrypto currently rejects PBKDF2 iteration counts above 100,000.
// Keep this at the supported ceiling so signup and credential verification
// work in production while retaining a strong password-derived key.
const ITERATIONS = 100_000;
const encoder = new TextEncoder();

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function derive(password: string, salt: Uint8Array): Promise<string> {
  const baseKey = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: ITERATIONS, hash: "SHA-256" }, baseKey, 256);
  return bytesToB64(new Uint8Array(bits));
}

export async function hashPassword(password: string): Promise<{ hash: string; salt: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: await derive(password, salt), salt: bytesToB64(salt) };
}

export async function verifyPassword(password: string, hash: string, salt: string): Promise<boolean> {
  const actual = await derive(password, b64ToBytes(salt));
  if (actual.length !== hash.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual.charCodeAt(index) ^ hash.charCodeAt(index);
  return difference === 0;
}

export async function nativeSessionIdentity(request: Request, env: Env): Promise<{ subject: string; email: string } | null> {
  if (!env.CRM_DB) return null;
  const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)twenty_session=([^;]+)/)?.[1];
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  const token = cookie || bearer;
  if (!token || !/^[a-zA-Z0-9_-]{16,128}$/.test(token)) return null;
  const now = new Date().toISOString();
  const row = await env.CRM_DB.prepare("SELECT s.identity_subject as subject, u.email as email FROM native_sessions s JOIN native_users u ON u.id = REPLACE(s.identity_subject, 'user:', '') WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ?").bind(token, now).first<{ subject: string; email: string }>();
  if (!row) return null;
  await env.CRM_DB.prepare("UPDATE native_sessions SET last_seen_at = ? WHERE id = ?").bind(now, token).run();
  return row;
}

export async function createNativeSession(env: Env, userId: string, workspaceId: string): Promise<{ id: string; expiresAt: string }> {
  const id = crypto.randomUUID().replace(/-/g, "");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString();
  await env.CRM_DB!.prepare("INSERT INTO native_sessions (id, workspace_id, identity_subject, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").bind(id, workspaceId, `user:${userId}`, now.toISOString(), now.toISOString(), expiresAt).run();
  return { id, expiresAt };
}
