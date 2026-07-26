import {
  RELEASE_MAINTENANCE_KEY,
  type ReleaseMaintenance,
} from "./release-contracts";

const CACHE_MS = 2_000;
let cachedAt = 0;
let cachedMaintenance: ReleaseMaintenance | null = null;

export async function getReleaseMaintenance(
  kv: KVNamespace,
  force = false,
): Promise<ReleaseMaintenance | null> {
  const now = Date.now();
  if (!force && now - cachedAt < CACHE_MS) return cachedMaintenance;
  cachedMaintenance = await kv.get<ReleaseMaintenance>(
    RELEASE_MAINTENANCE_KEY,
    "json",
  );
  cachedAt = now;
  return cachedMaintenance;
}

export async function putReleaseMaintenance(
  kv: KVNamespace,
  maintenance: ReleaseMaintenance,
): Promise<void> {
  await kv.put(RELEASE_MAINTENANCE_KEY, JSON.stringify(maintenance));
  cachedMaintenance = maintenance;
  cachedAt = Date.now();
}

export async function clearReleaseMaintenance(
  kv: KVNamespace,
  releaseId: string,
): Promise<boolean> {
  const active = await getReleaseMaintenance(kv, true);
  if (!active || active.releaseId !== releaseId) return false;
  await kv.delete(RELEASE_MAINTENANCE_KEY);
  cachedMaintenance = null;
  cachedAt = Date.now();
  return true;
}

export function maintenanceResponse(
  maintenance: ReleaseMaintenance,
): Response {
  return Response.json(
    {
      error: "scheduled maintenance",
      releaseId: maintenance.releaseId,
      startedAt: maintenance.startedAt,
    },
    {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "retry-after": "60",
      },
    },
  );
}
