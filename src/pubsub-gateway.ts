import { bearerAuthorized } from "./lib";
import type { Env } from "./types";
import type { PubSubReplay } from "./pubsub-do";

const MAX_CHANNEL_LENGTH = 512;
const MAX_EVENT_BODY_BYTES = 128 * 1024;

function validChannel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_CHANNEL_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export async function handlePubSubGateway(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (
    path === "/v1/events/socket" &&
    request.headers.get("upgrade")?.toLowerCase() === "websocket"
  ) {
    if (url.hostname !== "twenty-events.internal")
      return Response.json({ error: "not found" }, { status: 404 });
    const stub = env.PUBSUB_DO.get(
      env.PUBSUB_DO.idFromName("workspace:default"),
    );
    return stub.fetch(request);
  }
  if (
    !bearerAuthorized(
      request.headers.get("authorization"),
      env.INTERNAL_SERVICE_TOKEN,
    )
  )
    return Response.json({ error: "unauthorized" }, { status: 401 });
  if (request.method !== "POST")
    return Response.json({ error: "method not allowed" }, { status: 405 });
  const text = await request.text();
  if (!text || text.length > MAX_EVENT_BODY_BYTES)
    return Response.json({ error: "invalid body size" }, { status: 400 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  if (!validChannel(body.channel))
    return Response.json({ error: "invalid channel" }, { status: 400 });
  const stub = env.PUBSUB_DO.get(env.PUBSUB_DO.idFromName("workspace:default"));
  if (path === "/v1/events/publish")
    return Response.json({
      id: await stub.publish(body.channel, body.payload),
    });
  if (path === "/v1/events/cursor")
    return Response.json({ cursor: await stub.cursor(body.channel) });
  if (path === "/v1/events/poll") {
    if (
      typeof body.after !== "number" ||
      !Number.isSafeInteger(body.after) ||
      body.after < 0
    )
      return Response.json({ error: "invalid cursor" }, { status: 400 });
    const replay = (await stub.replay(
      body.channel,
      body.after,
      1,
    )) as PubSubReplay;
    if (replay.gap)
      return Response.json({
        event: null,
        gap: {
          requestedCursor: body.after,
          retentionFloor: replay.retentionFloor,
          latestCursor: replay.latestCursor,
        },
      });
    return Response.json({
      event:
        replay.events[0] ??
        (await stub.poll(body.channel, body.after, 25_000)),
      gap: null,
    });
  }
  if (path === "/v1/events/replay") {
    if (
      typeof body.after !== "number" ||
      !Number.isSafeInteger(body.after) ||
      body.after < 0 ||
      (body.limit !== undefined &&
        (typeof body.limit !== "number" ||
          !Number.isSafeInteger(body.limit) ||
          body.limit < 1 ||
          body.limit > 1_000))
    )
      return Response.json({ error: "invalid replay request" }, { status: 400 });
    return Response.json(
      await stub.replay(
        body.channel,
        body.after,
        typeof body.limit === "number" ? body.limit : 100,
      ),
    );
  }
  return Response.json({ error: "not found" }, { status: 404 });
}
