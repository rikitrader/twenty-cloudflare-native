import { parseWebhookEvent } from "./lib";
import type { Env, WebhookMessage } from "./types";

/**
 * Twenty webhook → CF Queue producer. Configure in Twenty:
 * Settings → API & Webhooks → target URL
 *   https://twenty-crm.rikitrader.workers.dev/webhooks/twenty?token=<WEBHOOK_TOKEN>
 */
export async function handleWebhook(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  if (!env.WEBHOOK_TOKEN || url.searchParams.get("token") !== env.WEBHOOK_TOKEN)
    return new Response("unauthorized", { status: 401 });
  if (request.method !== "POST")
    return new Response("method not allowed", { status: 405 });

  const parsed = parseWebhookEvent(await request.text());
  if (!parsed) return new Response("malformed payload", { status: 400 });

  await env.EVENTS_QUEUE.send({
    type: parsed.type,
    payload: parsed.payload,
    receivedAt: new Date().toISOString(),
  });
  return new Response("queued", { status: 202 });
}

/** Queue consumer → D1 events table. Per-message retry; DLQ after max retries. */
export async function consumeBatch(
  batch: MessageBatch<WebhookMessage>,
  env: Env,
): Promise<void> {
  const stmt = env.OPS_DB.prepare(
    "INSERT INTO events (type, payload, received_at) VALUES (?, ?, ?)",
  );
  for (const msg of batch.messages) {
    try {
      await stmt
        .bind(msg.body.type, msg.body.payload, msg.body.receivedAt)
        .run();
      msg.ack();
    } catch (e) {
      console.log("event insert failed, retrying:", e);
      msg.retry();
    }
  }
}
