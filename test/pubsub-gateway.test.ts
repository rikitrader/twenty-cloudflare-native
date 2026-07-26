import { describe, expect, it, vi } from "vitest";
import { handlePubSubGateway } from "../src/pubsub-gateway";
import type { Env } from "../src/types";

function env(): Env {
  return {
    INTERNAL_SERVICE_TOKEN: "internal-token",
    PUBSUB_DO: {
      idFromName: vi.fn().mockReturnValue("pubsub-id"),
      get: vi.fn().mockReturnValue({
        publish: vi.fn().mockResolvedValue(7),
        cursor: vi.fn().mockResolvedValue(6),
        replay: vi.fn().mockResolvedValue({
          events: [{ id: 7, payload: { ok: true } }],
          latestCursor: 7,
          retentionFloor: 0,
          gap: false,
          truncated: false,
        }),
        poll: vi.fn().mockResolvedValue({ id: 7, payload: { ok: true } }),
        fetch: vi.fn().mockResolvedValue(new Response("upgraded")),
      }),
    },
  } as unknown as Env;
}

function request(path: string, body: object, token = "internal-token") {
  return new Request(`http://twenty-events.internal${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("pubsub gateway", () => {
  it("publishes and polls typed events through the selected shard", async () => {
    const testEnv = env();
    const published = await handlePubSubGateway(
      request("/v1/events/publish", {
        channel: "agent-chat:workspace:thread",
        payload: { chunk: "hello" },
      }),
      testEnv,
    );
    expect(published.status).toBe(200);
    expect(await published.json()).toEqual({ id: 7 });

    const polled = await handlePubSubGateway(
      request("/v1/events/poll", {
        channel: "agent-chat:workspace:thread",
        after: 6,
      }),
      testEnv,
    );
    expect(await polled.json()).toEqual({
      event: { id: 7, payload: { ok: true } },
      gap: null,
    });
  });

  it("surfaces retention gaps instead of silently skipping events", async () => {
    const testEnv = env();
    const stub = testEnv.PUBSUB_DO.get(
      testEnv.PUBSUB_DO.idFromName("workspace:default"),
    );
    vi.mocked(stub.replay).mockResolvedValue({
      events: [],
      latestCursor: 99,
      retentionFloor: 75,
      gap: true,
      truncated: false,
    } as never);

    const response = await handlePubSubGateway(
      request("/v1/events/poll", {
        channel: "agent-chat:workspace:thread",
        after: 20,
      }),
      testEnv,
    );
    expect(await response.json()).toEqual({
      event: null,
      gap: {
        requestedCursor: 20,
        retentionFloor: 75,
        latestCursor: 99,
      },
    });
  });

  it("routes internal WebSocket upgrades to the hibernatable Durable Object", async () => {
    const testEnv = env();
    const response = await handlePubSubGateway(
      new Request("http://twenty-events.internal/v1/events/socket", {
        headers: { upgrade: "websocket" },
      }),
      testEnv,
    );
    expect(response.status).toBe(200);

    expect(
      (
        await handlePubSubGateway(
          new Request("https://public.example/v1/events/socket", {
            headers: { upgrade: "websocket" },
          }),
          testEnv,
        )
      ).status,
    ).toBe(404);
  });

  it("rejects public access and invalid channels", async () => {
    expect(
      (
        await handlePubSubGateway(
          request("/v1/events/cursor", { channel: "valid" }, "wrong"),
          env(),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handlePubSubGateway(
          request("/v1/events/cursor", { channel: "bad\nchannel" }),
          env(),
        )
      ).status,
    ).toBe(400);
  });
});
