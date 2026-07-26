import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearReleaseMaintenance,
  getReleaseMaintenance,
  maintenanceResponse,
  putReleaseMaintenance,
} from "../src/release-gate";
import {
  RELEASE_MAINTENANCE_KEY,
  type ReleaseMaintenance,
} from "../src/release-contracts";
import {
  createReleaseBranch,
  deleteReleaseBranch,
  type NeonReleaseEnv,
} from "../src/release/neon";

function memoryKv() {
  const values = new Map<string, string>();
  return {
    values,
    namespace: {
      get: vi.fn(async (key: string, type?: string) => {
        const value = values.get(key);
        if (value === undefined) return null;
        return type === "json" ? JSON.parse(value) : value;
      }),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        values.delete(key);
      }),
    } as unknown as KVNamespace,
  };
}

const maintenance: ReleaseMaintenance = {
  schemaVersion: 1,
  releaseId: "release-12345678",
  reason: "database-release",
  startedAt: "2026-07-25T12:00:00.000Z",
};

describe("release maintenance gate", () => {
  it("publishes and reads the active release record", async () => {
    const kv = memoryKv();
    await putReleaseMaintenance(kv.namespace, maintenance);
    expect(JSON.parse(kv.values.get(RELEASE_MAINTENANCE_KEY)!)).toEqual(
      maintenance,
    );
    expect(await getReleaseMaintenance(kv.namespace, true)).toEqual(
      maintenance,
    );
  });

  it("only lets the owning release clear maintenance", async () => {
    const kv = memoryKv();
    await putReleaseMaintenance(kv.namespace, maintenance);
    expect(
      await clearReleaseMaintenance(kv.namespace, "release-wrong-owner"),
    ).toBe(false);
    expect(kv.values.has(RELEASE_MAINTENANCE_KEY)).toBe(true);
    expect(
      await clearReleaseMaintenance(kv.namespace, maintenance.releaseId),
    ).toBe(true);
    expect(kv.values.has(RELEASE_MAINTENANCE_KEY)).toBe(false);
  });

  it("returns a fail-closed retryable response", async () => {
    const response = maintenanceResponse(maintenance);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      releaseId: maintenance.releaseId,
    });
  });
});

describe("Neon release branch lifecycle", () => {
  const env: NeonReleaseEnv = {
    NEON_API_KEY: "test-key",
    NEON_PROJECT_ID: "project-1",
    NEON_PARENT_BRANCH_ID: "branch-production",
    NEON_DATABASE_NAME: "default",
    NEON_ROLE_NAME: "owner",
  };

  afterEach(() => vi.unstubAllGlobals());

  it("creates minimum-compute expiring branches and retrieves their URI", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ branches: [] }),
      )
      .mockResolvedValueOnce(
        Response.json({ branch: { id: "branch-release" } }),
      )
      .mockResolvedValueOnce(
        Response.json({ uri: "postgresql://owner:secret@example/db" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createReleaseBranch(env, "release-12345678"),
    ).resolves.toEqual({
      branchId: "branch-release",
      databaseUrl: "postgresql://owner:secret@example/db",
    });
    const createRequest = fetchMock.mock.calls[1];
    const body = JSON.parse(createRequest[1].body);
    expect(body.branch.parent_id).toBe("branch-production");
    expect(Date.parse(body.branch.expires_at)).toBeGreaterThan(Date.now());
    expect(body.endpoints[0]).toMatchObject({
      type: "read_write",
      autoscaling_limit_min_cu: 0.25,
      autoscaling_limit_max_cu: 0.25,
      suspend_timeout_seconds: 60,
    });
  });

  it("falls back safely when the Neon plan rejects custom autosuspend", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ branches: [] }))
      .mockResolvedValueOnce(
        Response.json(
          { message: "modifying the suspend interval is not permitted" },
          { status: 412 },
        ),
      )
      .mockResolvedValueOnce(
        Response.json({ branch: { id: "branch-release" } }),
      )
      .mockResolvedValueOnce(
        Response.json({ uri: "postgresql://owner:secret@example/db" }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createReleaseBranch(env, "release-12345678"),
    ).resolves.toMatchObject({ branchId: "branch-release" });

    const fallbackBody = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(fallbackBody.branch.expires_at).toBeTruthy();
    expect(fallbackBody.endpoints[0]).toEqual({
      type: "read_write",
      autoscaling_limit_min_cu: 0.25,
      autoscaling_limit_max_cu: 0.25,
    });
  });

  it("deletes a release branch and accepts already-removed branches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      deleteReleaseBranch(env, "branch-release"),
    ).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });
});
