import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createCloudflareCacheStore,
}: {
  createCloudflareCacheStore(options: Record<string, unknown>): {
    name: string;
    client: {
      set(key: string, value: string, options: object): Promise<string | null>;
      del(key: string): Promise<number>;
      mGet(keys: string[]): Promise<(string | null)[]>;
      quit(): Promise<string>;
    };
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown, ttl?: number): Promise<void>;
  };
} = require("../cf/cloudflare-adapters/cache-store.cjs");
const {
  sessionTtl,
  createCloudflareSessionStore,
}: {
  sessionTtl(session: object, defaultTtl: number): number;
  createCloudflareSessionStore(
    sessionModule: { Store: new () => object },
    options: Record<string, unknown>,
  ): {
    get(sid: string, callback: (error: Error | null, value?: unknown) => void): void;
    set(sid: string, session: object, callback: (error: Error | null) => void): void;
    touch(sid: string, session: object, callback: (error: Error | null) => void): void;
    destroy(sid: string, callback: (error: Error | null) => void): void;
    clear(callback: (error: Error | null) => void): void;
  };
} = require("../cf/cloudflare-adapters/session-store.cjs");
const {
  CloudflareQueueDriver,
}: {
  CloudflareQueueDriver: new () => {
    add(
      queueName: string,
      jobName: string,
      data: unknown,
      options?: Record<string, unknown>,
    ): Promise<void>;
  };
} = require("../cf/cloudflare-adapters/queue-driver.cjs");
const {
  RollbackQueueDriver,
}: {
  RollbackQueueDriver: new (primary: Record<string, ReturnType<typeof vi.fn>>) => {
    register(queueName: string): unknown;
    add(
      queueName: string,
      jobName: string,
      data: unknown,
      options?: object,
    ): unknown;
    work(queueName: string, handler: () => void): unknown;
    onModuleDestroy(): Promise<void>;
  };
} = require("../cf/cloudflare-adapters/rollback-queue-driver.cjs");
const {
  CloudflareAsyncIterator,
  CloudflareEventClient,
  CloudflareRealtimeSocket,
  CloudflareRedisFacade,
  CloudflareSubscriber,
}: {
  CloudflareAsyncIterator: new (
    events: InstanceType<typeof CloudflareEventClient>,
    channel: string,
  ) => {
    next(): Promise<IteratorResult<unknown>>;
    return(): Promise<IteratorResult<unknown>>;
  };
  CloudflareEventClient: new () => {
    cursor(channel: string): Promise<{ cursor: number }>;
    poll(
      channel: string,
      after: number,
      signal?: AbortSignal,
    ): Promise<{ event: { id: number; payload: unknown } | null }>;
  };
  CloudflareRealtimeSocket: new (
    events: { socketUrl(): URL; token: string },
    channel: string,
    onEvent: (event: { id: number; payload: unknown }) => void,
    onError: (error: Error) => void,
  ) => {
    start(after: number): Promise<void>;
    close(): void;
  };
  CloudflareRedisFacade: new () => {
    set(
      key: string,
      value: string,
      mode: string,
      seconds: number,
    ): Promise<string>;
    exists(key: string): Promise<number>;
    rpush(key: string, value: string): Promise<number>;
    lrange(key: string, start: number, end: number): Promise<string[]>;
    publish(channel: string, payload: string): Promise<number>;
  };
  CloudflareSubscriber: new (
    events: InstanceType<typeof CloudflareEventClient>,
  ) => {
    on(event: string, callback: (...args: unknown[]) => void): unknown;
    subscribe(channel: string): Promise<number>;
    unsubscribe(channel: string): Promise<number>;
  };
} = require("../cf/cloudflare-adapters/redis-compat.cjs");

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.CLOUDFLARE_PUBSUB_TRANSPORT;
});

describe("Cloudflare container adapters", () => {
  it("preserves cache-manager values and Redis-compatible mGet encoding", async () => {
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (body.keys)
        return Response.json({ values: [{ id: 1 }, null] });
      if (body.value !== undefined)
        return Response.json({ found: true, value: body.value });
      return Response.json({ found: true, value: { id: 1 } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const store = createCloudflareCacheStore({
      token: "test-token",
      shard: "workspace:test",
      baseUrl: "http://state.internal",
      ttl: 60_000,
    });
    expect(store.name).toBe("redis");
    await store.set("cache key", { id: 1 });
    expect(await store.get("cache key")).toEqual({ id: 1 });
    expect(await store.client.mGet(["one", "two"])).toEqual([
      '{"id":1}',
      null,
    ]);
    expect(await store.client.quit()).toBe("OK");
  });

  it("invalidates a permission cache entry without touching another session", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        requests.push({ path: url.pathname, body });
        if (url.pathname.endsWith("/delete"))
          return Response.json({ deleted: body.key === "permissions:w:s1" });
        return Response.json({ found: true, value: body.value, deleted: false });
      }),
    );
    const store = createCloudflareCacheStore({
      token: "test-token",
      shard: "workspace:test",
      baseUrl: "http://state.internal",
      ttl: 60_000,
    });
    await store.set("permissions:w:s1", { role: "member" });
    await store.set("session:s2", { userId: "u-2" });
    expect(await store.client.del("permissions:w:s1")).toBe(1);
    expect(requests.map(({ path }) => path)).toEqual([
      "/v1/state/set",
      "/v1/state/set",
      "/v1/state/delete",
    ]);
    expect(requests[2].body.key).toBe("permissions:w:s1");
    expect(requests[2].body.key).not.toBe("session:s2");
  });

  it("releases a lock with the owner token created during acquisition", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      bodies.push(body);
      if (url.pathname.endsWith("/acquire"))
        return Response.json({ acquired: true, fencingToken: 7 });
      return Response.json({ released: true });
    });
    vi.stubGlobal("fetch", fetchMock);
    const store = createCloudflareCacheStore({
      token: "test-token",
      baseUrl: "http://state.internal",
    });

    expect(
      await store.client.set("lock key", "lock", { NX: true, PX: 1000 }),
    ).toBe("OK");
    expect(await store.client.del("lock key")).toBe(1);
    expect(bodies[1].owner).toBe(bodies[0].owner);
  });

  it("uses the session cookie lifetime and falls back safely", () => {
    expect(sessionTtl({ cookie: { originalMaxAge: 12_345 } }, 1000)).toBe(
      12_345,
    );
    expect(sessionTtl({ cookie: {} }, 30_000)).toBe(30_000);
  });

  it("completes the session lifecycle through state storage", async () => {
    process.env.INTERNAL_SERVICE_TOKEN = "test-token";
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        requests.push({ path: url.pathname, body });
        if (url.pathname.endsWith("/get"))
          return Response.json({ found: true, value: { userId: "u-1" } });
        if (url.pathname.endsWith("/clear"))
          return Response.json({ cleared: 1 });
        return Response.json({ updated: true, deleted: true });
      }),
    );
    class Store {}
    const store = createCloudflareSessionStore(
      { Store },
      { token: "test-token", baseUrl: "http://state.internal", ttlMs: 30_000 },
    );
    const session = { cookie: { originalMaxAge: 12_345 }, userId: "u-1" };
    await new Promise<void>((resolve, reject) =>
      store.set("sid-1", session, (error) => (error ? reject(error) : resolve())),
    );
    const loaded = await new Promise<unknown>((resolve, reject) =>
      store.get("sid-1", (error, value) => (error ? reject(error) : resolve(value))),
    );
    expect(loaded).toEqual({ userId: "u-1" });
    await new Promise<void>((resolve, reject) =>
      store.touch("sid-1", session, (error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      store.destroy("sid-1", (error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      store.clear((error) => (error ? reject(error) : resolve())),
    );
    expect(requests.map(({ path }) => path)).toEqual([
      "/v1/state/set",
      "/v1/state/get",
      "/v1/state/expire",
      "/v1/state/delete",
      "/v1/state/clear",
    ]);
    expect(requests[0].body).toMatchObject({ key: "engine:session:sid-1", ttlMs: 12_345 });
    expect(requests[2].body).toMatchObject({ key: "engine:session:sid-1", ttlMs: 12_345 });
    delete process.env.INTERNAL_SERVICE_TOKEN;
  });

  it("translates Twenty queue options into a versioned job envelope", async () => {
    process.env.INTERNAL_SERVICE_TOKEN = "test-token";
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        schemaVersion: 1,
        queueName: "defaultQueue",
        jobName: "ExampleJob",
        retryLimit: 2,
        priority: 3,
        dedupeKey: "defaultQueue:record",
      });
      return Response.json({ queued: true }, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const driver = new CloudflareQueueDriver();
    await driver.add(
      "defaultQueue",
      "ExampleJob",
      { workspaceId: "workspace" },
      { retryLimit: 2, priority: 3, id: "record", delay: 1000 },
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    delete process.env.INTERNAL_SERVICE_TOKEN;
  });

  it("keeps Redis primary while registering a consumer-only rollback drain", async () => {
    process.env.INTERNAL_SERVICE_TOKEN = "test-token";
    const primary = {
      register: vi.fn(() => "registered"),
      add: vi.fn(() => "redis-enqueued"),
      addCron: vi.fn(),
      removeCron: vi.fn(),
      work: vi.fn(() => "redis-worker"),
      onModuleDestroy: vi.fn(async () => {}),
    };
    const driver = new RollbackQueueDriver(primary);
    const handler = vi.fn();
    expect(driver.register("defaultQueue")).toBe("registered");
    expect(driver.add("defaultQueue", "job", null)).toBe("redis-enqueued");
    expect(driver.work("defaultQueue", handler)).toBe("redis-worker");
    expect(primary.add).toHaveBeenCalledOnce();
    expect(primary.work).toHaveBeenCalledWith("defaultQueue", handler);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await driver.onModuleDestroy();
    expect(primary.onModuleDestroy).toHaveBeenCalledOnce();
    delete process.env.INTERNAL_SERVICE_TOKEN;
  });

  it("covers Twenty's direct AI Redis surface through typed gateways", async () => {
    process.env.INTERNAL_SERVICE_TOKEN = "test-token";
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (url.pathname.endsWith("/get"))
        return Response.json({ found: true, value: "1" });
      if (url.pathname.endsWith("/append"))
        return Response.json({ length: 2 });
      if (url.pathname.endsWith("/range"))
        return Response.json({ values: ['{"text":"a"}', '{"text":"b"}'] });
      if (url.pathname.endsWith("/publish"))
        return Response.json({ id: 9 });
      return Response.json({ found: true, value: body.value });
    });
    vi.stubGlobal("fetch", fetchMock);
    const redis = new CloudflareRedisFacade();
    expect(await redis.set("alive", "1", "EX", 30)).toBe("OK");
    expect(await redis.exists("alive")).toBe(1);
    expect(await redis.rpush("chunks", '{"text":"b"}')).toBe(2);
    expect(await redis.lrange("chunks", 0, -1)).toHaveLength(2);
    expect(await redis.publish("cancel:stream", "cancel")).toBe(9);
    delete process.env.INTERNAL_SERVICE_TOKEN;
  });

  it("aborts an in-flight realtime poll when an AI iterator is cancelled", async () => {
    process.env.INTERNAL_SERVICE_TOKEN = "test-token";
    process.env.CLOUDFLARE_PUBSUB_TRANSPORT = "poll";
    let pollAborted = false;
    const fetchMock = vi.fn(
      async (url: URL, init: RequestInit): Promise<Response> => {
        if (url.pathname.endsWith("/cursor"))
          return Response.json({ cursor: 0 });
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              pollAborted = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const iterator = new CloudflareAsyncIterator(
      new CloudflareEventClient(),
      "ai:stream",
    );
    const pending = iterator.next();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await iterator.return();
    await expect(pending).resolves.toEqual({
      done: true,
      value: undefined,
    });
    expect(pollAborted).toBe(true);
    delete process.env.INTERNAL_SERVICE_TOKEN;
  });

  it("aborts subscriber polling immediately on unsubscribe", async () => {
    process.env.INTERNAL_SERVICE_TOKEN = "test-token";
    process.env.CLOUDFLARE_PUBSUB_TRANSPORT = "poll";
    let pollAborted = false;
    const fetchMock = vi.fn(
      async (url: URL, init: RequestInit): Promise<Response> => {
        if (url.pathname.endsWith("/cursor"))
          return Response.json({ cursor: 0 });
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => {
              pollAborted = true;
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const errors = vi.fn();
    const subscriber = new CloudflareSubscriber(
      new CloudflareEventClient(),
    );
    subscriber.on("error", errors);
    await subscriber.subscribe("workspace:events");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await subscriber.unsubscribe("workspace:events")).toBe(0);
    await vi.waitFor(() => expect(pollAborted).toBe(true));
    expect(errors).not.toHaveBeenCalled();
    delete process.env.INTERNAL_SERVICE_TOKEN;
  });

  it("reconnects a realtime WebSocket from the last delivered cursor", async () => {
    vi.useFakeTimers();
    class FakeWebSocket {
      static instances: FakeWebSocket[] = [];
      listeners = new Map<string, Array<(event: { data?: string }) => void>>();
      sent: string[] = [];

      constructor(_url: URL) {
        FakeWebSocket.instances.push(this);
      }

      addEventListener(
        type: string,
        callback: (event: { data?: string }) => void,
      ) {
        const callbacks = this.listeners.get(type) ?? [];
        callbacks.push(callback);
        this.listeners.set(type, callbacks);
      }

      send(message: string) {
        this.sent.push(message);
      }

      close() {
        this.emit("close");
      }

      emit(type: string, data?: object) {
        for (const callback of this.listeners.get(type) ?? [])
          callback({ data: data === undefined ? undefined : JSON.stringify(data) });
      }
    }
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const delivered = vi.fn();
    const errors = vi.fn();
    const channel = new CloudflareRealtimeSocket(
      {
        socketUrl: () => new URL("ws://twenty-events.internal/v1/events/socket"),
        token: "internal-token",
      },
      "workspace:events",
      delivered,
      errors,
    );

    const ready = channel.start(5);
    const first = FakeWebSocket.instances[0];
    first.emit("open");
    expect(JSON.parse(first.sent[0])).toMatchObject({
      type: "authenticate",
      channel: "workspace:events",
      after: 5,
    });
    first.emit("message", {
      type: "event",
      event: { id: 6, payload: { ok: true } },
    });
    first.emit("message", {
      type: "ready",
      cursor: 6,
      latestCursor: 6,
      truncated: false,
    });
    await ready;
    expect(delivered).toHaveBeenCalledWith({
      id: 6,
      payload: { ok: true },
    });

    first.emit("close");
    await vi.advanceTimersByTimeAsync(250);
    const second = FakeWebSocket.instances[1];
    second.emit("open");
    expect(JSON.parse(second.sent[0])).toMatchObject({
      type: "authenticate",
      after: 6,
    });
    second.emit("message", {
      type: "ready",
      cursor: 6,
      latestCursor: 6,
      truncated: false,
    });
    expect(errors).not.toHaveBeenCalled();
    channel.close();
    vi.useRealTimers();
  });
});
