import { describe, expect, it, vi } from "vitest";
import { handleWebhook } from "../src/queue";
import type { Env } from "../src/types";

function webhookEnv(send = vi.fn()): Env {
  return {
    WEBHOOK_TOKEN: "hook-secret",
    EVENTS_QUEUE: { send },
  } as unknown as Env;
}

describe("handleWebhook", () => {
  it("accepts bearer authentication and queues a valid event", async () => {
    const send = vi.fn();
    const response = await handleWebhook(
      new Request("https://example.com/webhooks/twenty", {
        method: "POST",
        headers: { authorization: "Bearer hook-secret" },
        body: JSON.stringify({ eventName: "company.created", record: { id: 1 } }),
      }),
      webhookEnv(send),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("deprecation")).toBeNull();
    expect(send).toHaveBeenCalledOnce();
  });

  it("temporarily accepts but marks legacy query authentication deprecated", async () => {
    const response = await handleWebhook(
      new Request(
        "https://example.com/webhooks/twenty?token=hook-secret",
        {
          method: "POST",
          body: JSON.stringify({ eventName: "company.created" }),
        },
      ),
      webhookEnv(),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("deprecation")).toBe("true");
  });

  it("rejects missing credentials before parsing the body", async () => {
    const send = vi.fn();
    const response = await handleWebhook(
      new Request("https://example.com/webhooks/twenty", {
        method: "POST",
        body: "not-json",
      }),
      webhookEnv(send),
    );

    expect(response.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });
});
