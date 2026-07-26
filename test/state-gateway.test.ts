import { describe, expect, it, vi } from "vitest";
import { handleStateGateway } from "../src/cloudflare-state/gateway";
import type { Env } from "../src/types";

function stateEnv(methods: Record<string, ReturnType<typeof vi.fn>> = {}): Env {
  const stub = {
    getValue: vi.fn().mockResolvedValue({ found: false }),
    setValue: vi.fn().mockResolvedValue({ found: true, value: "saved" }),
    deleteValue: vi.fn().mockResolvedValue(true),
    getValues: vi.fn().mockResolvedValue([null]),
    deleteValues: vi.fn().mockResolvedValue(1),
    expireKey: vi.fn().mockResolvedValue(true),
    increment: vi.fn().mockResolvedValue({ found: true, value: 2 }),
    setAdd: vi.fn().mockResolvedValue(1),
    setRemove: vi.fn().mockResolvedValue(1),
    setPop: vi.fn().mockResolvedValue("member"),
    setCard: vi.fn().mockResolvedValue(1),
    setMembers: vi.fn().mockResolvedValue(["member"]),
    hashValues: vi.fn().mockResolvedValue(["value"]),
    hashSet: vi.fn().mockResolvedValue(1),
    hashDelete: vi.fn().mockResolvedValue(true),
    listAppend: vi.fn().mockResolvedValue(1),
    listRange: vi.fn().mockResolvedValue([]),
    scanKeys: vi.fn().mockResolvedValue({ keys: [] }),
    clearNamespace: vi.fn().mockResolvedValue(0),
    acquireLock: vi.fn().mockResolvedValue({
      acquired: true,
      fencingToken: 1,
    }),
    releaseLock: vi.fn().mockResolvedValue(true),
    markJobExecutionStarted: vi.fn().mockResolvedValue(true),
    health: vi.fn().mockResolvedValue({
      status: "ok",
      values: 0,
      sets: 0,
      hashes: 0,
      lists: 0,
      locks: 0,
      nextCleanupAt: null,
    }),
    ...methods,
  };
  return {
    INTERNAL_SERVICE_TOKEN: "internal-secret",
    STATE_DO: {
      idFromName: vi.fn().mockReturnValue("state-id"),
      get: vi.fn().mockReturnValue(stub),
    },
  } as unknown as Env;
}

function request(
  path: string,
  body: Record<string, unknown>,
  token = "internal-secret",
): Request {
  return new Request(`http://twenty-state.internal${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-twenty-state-shard": "workspace:test",
    },
    body: JSON.stringify(body),
  });
}

describe("state gateway", () => {
  it("rejects unauthorized requests before accessing the Durable Object", async () => {
    const env = stateEnv();
    const response = await handleStateGateway(
      request("/v1/state/get", { namespace: "cache", key: "one" }, "wrong"),
      env,
    );
    expect(response.status).toBe(401);
    expect(env.STATE_DO.idFromName).not.toHaveBeenCalled();
  });

  it("routes validated state writes to a deterministic shard", async () => {
    const setValue = vi.fn().mockResolvedValue({
      found: true,
      value: { company: 1 },
      version: 1,
    });
    const env = stateEnv({ setValue });
    const response = await handleStateGateway(
      request("/v1/state/set", {
        namespace: "cache",
        key: "company:1",
        value: { company: 1 },
        ttlMs: 60_000,
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(env.STATE_DO.idFromName).toHaveBeenCalledWith("workspace:test");
    expect(setValue).toHaveBeenCalledWith({
      namespace: "cache",
      key: "company:1",
      value: { company: 1 },
      ttlMs: 60_000,
    });
  });

  it("accepts application keys while rejecting control characters and unsafe TTLs", async () => {
    const env = stateEnv();
    const validKey = await handleStateGateway(
      request("/v1/state/get", { namespace: "cache", key: "spaces are valid" }),
      env,
    );
    expect(validKey.status).toBe(200);

    const invalidKey = await handleStateGateway(
      request("/v1/state/get", { namespace: "cache", key: "line\nbreak" }),
      env,
    );
    expect(invalidKey.status).toBe(400);

    const invalidTtl = await handleStateGateway(
      request("/v1/state/set", {
        namespace: "cache",
        key: "one",
        value: 1,
        ttlMs: -1,
      }),
      env,
    );
    expect(invalidTtl.status).toBe(400);
  });

  it("routes typed set and hash operations without exposing Redis commands", async () => {
    const setAdd = vi.fn().mockResolvedValue(2);
    const hashSet = vi.fn().mockResolvedValue(1);
    const env = stateEnv({ setAdd, hashSet });

    expect(
      (
        await handleStateGateway(
          request("/v1/set/add", {
            namespace: "cache",
            key: "queue members",
            members: ["one", "two"],
          }),
          env,
        )
      ).status,
    ).toBe(200);
    expect(setAdd).toHaveBeenCalledWith({
      namespace: "cache",
      key: "queue members",
      members: ["one", "two"],
    });

    expect(
      (
        await handleStateGateway(
          request("/v1/hash/set", {
            namespace: "cache",
            key: "hash",
            field: "field",
            value: "encoded",
            ttlMs: 5000,
          }),
          env,
        )
      ).status,
    ).toBe(200);
    expect(hashSet).toHaveBeenCalledWith({
      namespace: "cache",
      key: "hash",
      field: "field",
      value: "encoded",
      ttlMs: 5000,
    });
  });

  it("preserves lock ownership and fencing responses", async () => {
    const acquireLock = vi.fn().mockResolvedValue({
      acquired: true,
      fencingToken: 42,
      expiresAt: 1234,
    });
    const env = stateEnv({ acquireLock });
    const response = await handleStateGateway(
      request("/v1/lock/acquire", {
        namespace: "locks",
        key: "workflow:1",
        owner: "worker:abc",
        ttlMs: 30_000,
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      acquired: true,
      fencingToken: 42,
    });
  });

  it("marks a reserved job as started only with a validated owner", async () => {
    const markJobExecutionStarted = vi.fn().mockResolvedValue(true);
    const env = stateEnv({ markJobExecutionStarted });
    const response = await handleStateGateway(
      request("/v1/job-execution/started", {
        jobId: "job-123",
        owner: "delivery-456",
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ started: true });
    expect(markJobExecutionStarted).toHaveBeenCalledWith({
      jobId: "job-123",
      owner: "delivery-456",
    });
    expect(
      (
        await handleStateGateway(
          request("/v1/job-execution/started", {
            jobId: "job-123",
            owner: "line\nbreak",
          }),
          env,
        )
      ).status,
    ).toBe(400);
  });
});
