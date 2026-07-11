import { Container, getContainer } from "@cloudflare/containers";

interface Env {
  TWENTY: DurableObjectNamespace;
  SERVER_URL: string;
  APP_SECRET: string;
}

export class TwentyContainer extends Container<Env> {
  // The all-in-one dev image serves Twenty on 2020.
  defaultPort = 2020;
  // Ephemeral demo: data lives only while the instance is awake.
  // Long idle window so an evaluation session isn't wiped mid-day.
  sleepAfter = "2h";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.envVars = {
      SERVER_URL: env.SERVER_URL,
      // Falls back to the image's built-in dev secret until the Worker secret is set.
      ...(env.APP_SECRET ? { APP_SECRET: env.APP_SECRET } : {}),
    };
  }

  override onStart() {
    console.log("Twenty container started");
  }

  override onError(error: unknown) {
    console.log("Twenty container error:", error);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Single shared instance — this is a one-team CRM, not per-session sandboxes.
    return getContainer(env.TWENTY, "main").fetch(request);
  },
} satisfies ExportedHandler<Env>;
