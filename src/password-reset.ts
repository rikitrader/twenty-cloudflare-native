import type { Env } from "./types";

const encoder = new TextEncoder();
const RESET_TTL_MS = 30 * 60 * 1000;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function resetUrl(request: Request, token: string): string {
  const origin = new URL(request.url).origin;
  return `${origin}/reset-password/${encodeURIComponent(token)}`;
}

/**
 * Issue and deliver a single-use native password reset token. The response is
 * deliberately identical for unknown addresses so the public endpoint cannot
 * be used to enumerate accounts.
 */
export async function requestPasswordReset(
  request: Request,
  env: Env,
  email: string,
): Promise<Response> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(normalizedEmail) || normalizedEmail.length > 254) {
    return Response.json({ errors: [{ message: "valid email is required" }] }, { status: 400 });
  }
  if (env.OPS_RATE_LIMITER) {
    const allowed = await env.OPS_RATE_LIMITER.limit({ key: `password-reset:${normalizedEmail}` });
    if (!allowed.success) {
      return Response.json({ errors: [{ message: "too many password reset requests" }] }, { status: 429 });
    }
  }

  const genericSuccess = () => Response.json({ data: { emailPasswordResetLink: { success: true } } });
  const user = await env.CRM_DB!.prepare(
    "SELECT id, email FROM native_users WHERE email = ? COLLATE NOCASE LIMIT 1",
  ).bind(normalizedEmail).first<{ id: string; email: string }>();
  if (!user) return genericSuccess();
  if (!env.CRM_EMAIL || !env.CRM_EMAIL_FROM) {
    return Response.json(
      { errors: [{ message: "password reset email service is unavailable", extensions: { code: "PROVIDER_NOT_CONFIGURED" } }] },
      { status: 503 },
    );
  }

  const random = crypto.getRandomValues(new Uint8Array(32));
  const token = base64Url(random);
  const tokenHash = await digest(token);
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + RESET_TTL_MS).toISOString();
  await env.CRM_DB!.prepare(
    "INSERT INTO native_password_resets (id, user_id, token_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)",
  ).bind(id, user.id, tokenHash, expiresAt, now.toISOString()).run();

  const link = resetUrl(request, token);
  try {
    await env.CRM_EMAIL.send({
      from: { email: env.CRM_EMAIL_FROM, name: "Twenty CRM" },
      to: [user.email],
      subject: "Reset your Twenty CRM password",
      html: `<p>We received a request to reset your Twenty CRM password.</p><p><a href="${link}">Reset your password</a></p><p>This link expires in 30 minutes. If you did not request it, you can ignore this email.</p>`,
      text: `Reset your Twenty CRM password: ${link}\n\nThis link expires in 30 minutes. If you did not request it, you can ignore this email.`,
    });
  } catch {
    await env.CRM_DB!.prepare("DELETE FROM native_password_resets WHERE id = ? AND used_at IS NULL").bind(id).run();
    return Response.json(
      { errors: [{ message: "password reset email could not be delivered", extensions: { code: "EMAIL_DELIVERY_FAILED" } }] },
      { status: 503 },
    );
  }

  return genericSuccess();
}

export async function validatePasswordReset(env: Env, token: string): Promise<Response> {
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) {
    return Response.json({ data: { validatePasswordResetToken: null } });
  }
  const tokenHash = await digest(token);
  const row = await env.CRM_DB!.prepare(
    "SELECT r.id, u.email, u.password_hash as passwordHash FROM native_password_resets r JOIN native_users u ON u.id = r.user_id WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ? LIMIT 1",
  ).bind(tokenHash, new Date().toISOString()).first<{ id: string; email: string; passwordHash: string }>();
  return Response.json({
    data: {
      validatePasswordResetToken: row
        ? { id: row.id, email: row.email, hasPassword: Boolean(row.passwordHash) }
        : null,
    },
  });
}
