import { TwentyPubSub } from "../src/pubsub-do";

export { TwentyPubSub };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const stub = env.PUBSUB_DO.get(env.PUBSUB_DO.idFromName("workspace:default"));
    const channel = url.searchParams.get("channel") ?? "eviction-test";
    if (url.pathname === "/publish" && request.method === "POST") {
      return Response.json({ id: await stub.publish(channel, { ok: true }) });
    }
    if (url.pathname === "/replay") {
      return Response.json(await stub.replay(channel, 0, 100));
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
};

interface Env {
  PUBSUB_DO: DurableObjectNamespace<TwentyPubSub>;
  CANARY_MODE: string;
  INTERNAL_SERVICE_TOKEN: string;
}
