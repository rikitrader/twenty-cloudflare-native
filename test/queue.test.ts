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
  async function signed(raw:string,timestamp=String(Math.floor(Date.now()/1000))){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode('hook-secret'),{name:'HMAC',hash:'SHA-256'},false,['sign']);const bytes=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`${timestamp}:${raw}`));return{timestamp,signature:[...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,'0')).join('')};}
  it("accepts a valid Twenty HMAC and queues a deterministic event", async () => {
    const send = vi.fn();
    const raw=JSON.stringify({ event: "company.created", data: { id: 1 } });const auth=await signed(raw);
    const response = await handleWebhook(
      new Request("https://example.com/webhooks/twenty", {
        method: "POST",
        headers: { 'x-twenty-webhook-timestamp':auth.timestamp,'x-twenty-webhook-signature':auth.signature },body:raw,
      }),
      webhookEnv(send),
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("deprecation")).toBeNull();
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0][0]).toMatchObject({type:'company.created',eventId:expect.stringMatching(/^[0-9a-f]{64}$/)});
  });

  it("rejects bearer/query credentials without the required HMAC", async () => {
    const send = vi.fn();
    const response = await handleWebhook(
      new Request(
        "https://example.com/webhooks/twenty?token=hook-secret",
        {
          method: "POST",headers:{authorization:'Bearer hook-secret'},
          body: JSON.stringify({ eventName: "company.created" }),
        },
      ),
      webhookEnv(send),
    );

    expect(response.status).toBe(401);
    expect(send).not.toHaveBeenCalled();
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

  it('rejects expired signatures and replay attempts outside the window',async()=>{const raw=JSON.stringify({event:'company.created',data:{id:1}}),timestamp=String(Math.floor((Date.now()-3600_000)/1000)),auth=await signed(raw,timestamp),send=vi.fn();const response=await handleWebhook(new Request('https://example.com/webhooks/twenty',{method:'POST',headers:{'x-twenty-webhook-timestamp':timestamp,'x-twenty-webhook-signature':auth.signature},body:raw}),webhookEnv(send));expect(response.status).toBe(401);expect(send).not.toHaveBeenCalled();});
});
