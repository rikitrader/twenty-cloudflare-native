// Pure helpers — no Cloudflare imports so vitest can load this file directly.

/** backups/2026-07-10T2200.sql — lexicographic order == chronological order. */
export function backupKey(d: Date): string {
  const iso = d.toISOString(); // 2026-07-10T22:00:13.123Z
  return `backups/${iso.slice(0, 13)}${iso.slice(14, 16)}.sql`;
}

/** Newest key by lexicographic max; null when there are none. */
export function pickLatest(keys: string[]): string | null {
  if (keys.length === 0) return null;
  return keys.reduce((a, b) => (b > a ? b : a));
}

/**
 * Skip when there has been no traffic since the last backup — never wake a
 * sleeping container just to dump untouched (or worse, freshly-seeded) data.
 */
export function shouldSkipBackup(
  lastActivityIso: string | null,
  lastBackupIso: string | null,
): boolean {
  if (!lastActivityIso) return true; // no traffic ever recorded
  if (!lastBackupIso) return false; // activity exists, never backed up
  return lastActivityIso <= lastBackupIso;
}

/** Constant-shape bearer check for the backup/agent endpoints. */
export function bearerAuthorized(
  authHeader: string | null,
  token: string | undefined,
): boolean {
  return Boolean(token) && authHeader === `Bearer ${token}`;
}

/** Twenty webhook payload → queue message fields, or null if malformed. */
export function parseWebhookEvent(
  raw: string,
): { type: string; payload: string } | null {
  if (raw.length === 0 || raw.length > 100_000) return null;
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    const type =
      typeof body.eventName === "string"
        ? body.eventName
        : typeof body.type === "string"
          ? body.type
          : "unknown";
    return { type, payload: raw };
  } catch {
    return null;
  }
}
