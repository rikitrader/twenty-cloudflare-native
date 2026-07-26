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

export function boundedReplicaCount(
  value: string | undefined,
  maximum = 16,
): number {
  if (!value || !/^\d+$/.test(value)) return 1;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1
    ? Math.min(parsed, maximum)
    : 1;
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

/** Coalesce noisy status updates while still recording health transitions. */
export function shouldWriteStatus(
  nowMs: number,
  lastWriteMs: number,
  ok: boolean,
  lastOk: boolean | undefined,
  intervalMs: number,
): boolean {
  return lastOk !== ok || nowMs - lastWriteMs >= intervalMs;
}

/** Keep paid containers warm only while real customer traffic is recent. */
export function hasRecentCustomerActivity(
  nowMs: number,
  lastActivityIso: string | null,
  activeWindowMs = 20 * 60_000,
): boolean {
  if (!lastActivityIso) return false;
  const lastActivityMs = Date.parse(lastActivityIso);
  return (
    Number.isFinite(lastActivityMs) &&
    lastActivityMs <= nowMs &&
    nowMs - lastActivityMs <= activeWindowMs
  );
}

/** Browser navigations can use the versioned, anonymous SPA shell at the edge. */
export function isEdgeShellRequest(
  method: string,
  pathname: string,
  accept: string | null,
): boolean {
  return (
    method === "GET" &&
    Boolean(accept?.includes("text/html")) &&
    !pathname.startsWith("/_") &&
    !pathname.startsWith("/graphql") &&
    !pathname.startsWith("/metadata") &&
    !pathname.includes(".")
  );
}

export interface OperationalStatusInput {
  reportedStatus: unknown;
  checkedIso: unknown;
  lastBackupIso: string | null;
  lastBackupError: string | null;
  backupRequired: boolean;
}

export interface OperationalStatus {
  status: "ok" | "degraded";
  reasons: string[];
}

/** Fail closed when health or required backup evidence becomes stale. */
export function evaluateOperationalStatus(
  nowMs: number,
  input: OperationalStatusInput,
  healthMaxAgeMs = 10 * 60_000,
  backupMaxAgeMs = 2 * 60 * 60_000,
): OperationalStatus {
  const reasons: string[] = [];
  const checkedMs =
    typeof input.checkedIso === "string" ? Date.parse(input.checkedIso) : NaN;

  if (input.reportedStatus !== "ok") reasons.push("upstream-degraded");
  if (!Number.isFinite(checkedMs) || nowMs - checkedMs > healthMaxAgeMs)
    reasons.push("health-stale");

  if (input.backupRequired) {
    const backupMs = input.lastBackupIso
      ? Date.parse(input.lastBackupIso)
      : NaN;
    if (!Number.isFinite(backupMs) || nowMs - backupMs > backupMaxAgeMs)
      reasons.push("backup-stale");
    if (input.lastBackupError) reasons.push("backup-error");
  }

  return {
    status: reasons.length === 0 ? "ok" : "degraded",
    reasons,
  };
}

/** Keep operational status safe and compact when surfacing workflow failures. */
export function sanitizedErrorMessage(error: unknown, maxLength = 500): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, maxLength).trimEnd();
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
