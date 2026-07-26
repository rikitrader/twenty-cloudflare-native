import { Container } from "@cloudflare/containers";
import { handleStateGateway } from "../cloudflare-state/gateway";
import {
  STATE_GATEWAY_HOST,
} from "../cloudflare-state/contracts";
import { handleQueueGateway } from "../jobs";
import { handlePubSubGateway } from "../pubsub-gateway";
import {
  EVENT_GATEWAY_HOST,
  JOB_GATEWAY_HOST,
} from "../containers";
import type { Env } from "../types";
import type { ReleaseEnv } from "./types";

export const RELEASE_AGENT_PORT = 2023;

const releaseOutbound = {
  [STATE_GATEWAY_HOST]: (request: Request, env: ReleaseEnv) =>
    handleStateGateway(request, env as unknown as Env),
  [JOB_GATEWAY_HOST]: (request: Request, env: ReleaseEnv) =>
    handleQueueGateway(request, env as unknown as Env),
  [EVENT_GATEWAY_HOST]: (request: Request, env: ReleaseEnv) =>
    handlePubSubGateway(request, env as unknown as Env),
};

export interface ReleaseAgentRequest {
  requestId: string;
  databaseUrl: string;
  phase: "preflight" | "production";
  allowInitialize?: boolean;
  runtime: {
    internalServiceToken: string;
    encryptionKey: string;
    fallbackEncryptionKey?: string;
    appSecret?: string;
  };
}

export interface ReleaseAgentStatus {
  requestId?: string;
  phase?: "preflight" | "production";
  status: "idle" | "running" | "complete" | "failed";
  startedAt?: string;
  completedAt?: string | null;
  error?: string | null;
  log?: string;
}

export class TwentyReleaseContainer extends Container<ReleaseEnv> {
  static override outboundByHost = releaseOutbound;
  defaultPort = RELEASE_AGENT_PORT;
  sleepAfter = "10m";
  entrypoint = ["node", "/cf/release-agent.js"];

  constructor(ctx: DurableObjectState<{}>, env: ReleaseEnv) {
    super(ctx, env);
    this.envVars = {
      SERVER_URL: env.SERVER_URL,
      LOGIC_FUNCTION_TYPE: "LOCAL",
      REDIS_BACKEND: "cloudflare",
      CLOUDFLARE_STATE_URL: `http://${STATE_GATEWAY_HOST}`,
      CLOUDFLARE_QUEUE_URL: `http://${JOB_GATEWAY_HOST}`,
      CLOUDFLARE_EVENTS_URL: `http://${EVENT_GATEWAY_HOST}`,
      CLOUDFLARE_STATE_SHARD: "workspace:default",
      CLOUDFLARE_QUEUE_DRAIN: "true",
      DISABLE_DB_MIGRATIONS: "true",
      DISABLE_CRON_JOBS_REGISTRATION: "true",
    };
  }

  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path !== "/run" && path !== "/status")
      return new Response("not found", { status: 404 });
    await this.startAndWaitForPorts(this.defaultPort, {
      portReadyTimeoutMS: 300_000,
      instanceGetTimeoutMS: 300_000,
      waitInterval: 500,
      abort: request.signal,
    });
    return this.containerFetch(
      new Request(`http://release-agent${path}`, {
        method: request.method,
        headers: { "content-type": "application/json" },
        body: request.body,
      }),
      this.defaultPort,
    );
  }
}
