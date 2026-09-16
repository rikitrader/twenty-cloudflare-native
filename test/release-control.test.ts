import { describe, expect, it, vi } from "vitest";
import { clearReleaseMaintenance, getReleaseMaintenance, maintenanceResponse, putReleaseMaintenance } from "../src/release-gate";
import { RELEASE_MAINTENANCE_KEY, type ReleaseMaintenance } from "../src/release-contracts";

function memoryKv() {
  const values = new Map<string, string>();
  return { values, namespace: {
    get: vi.fn(async (key: string, type?: string) => { const value = values.get(key); return value === undefined ? null : type === "json" ? JSON.parse(value) : value; }),
    put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    delete: vi.fn(async (key: string) => { values.delete(key); }),
  } as unknown as KVNamespace };
}

const maintenance: ReleaseMaintenance = { schemaVersion: 1, releaseId: "release-12345678", reason: "database-release", startedAt: "2026-07-25T12:00:00.000Z" };

describe("native maintenance gate", () => {
  it("publishes and reads the active release record", async () => {
    const kv = memoryKv();
    await putReleaseMaintenance(kv.namespace, maintenance);
    expect(JSON.parse(kv.values.get(RELEASE_MAINTENANCE_KEY)!)).toEqual(maintenance);
    expect(await getReleaseMaintenance(kv.namespace, true)).toEqual(maintenance);
  });
  it("only lets the owning release clear maintenance", async () => {
    const kv = memoryKv();
    await putReleaseMaintenance(kv.namespace, maintenance);
    expect(await clearReleaseMaintenance(kv.namespace, "release-wrong-owner")).toBe(false);
    expect(await clearReleaseMaintenance(kv.namespace, maintenance.releaseId)).toBe(true);
  });
  it("returns a fail-closed retryable response", async () => {
    const response = maintenanceResponse(maintenance);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
  });
});
