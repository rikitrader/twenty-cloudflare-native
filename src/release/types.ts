import type { TwentyState } from "../cloudflare-state/state-do";
import type { TwentyScheduler } from "../schedule-do";
import type { TwentyPubSub } from "../pubsub-do";
import type { ReleaseControlService } from "../index";
import type {
  CloudflareTwentyJob,
  WebhookMessage,
} from "../types";
import type { TwentyReleaseContainer } from "./container";
import type { NeonReleaseEnv } from "./neon";

export interface ReleaseEnv extends NeonReleaseEnv {
  OPS_DB: D1Database;
  STATUS_KV: KVNamespace;
  STORAGE: R2Bucket;
  RELEASE_CONTAINER: DurableObjectNamespace<TwentyReleaseContainer>;
  RELEASE_WF: Workflow;
  PRODUCTION: Service<ReleaseControlService>;
  STATE_DO: DurableObjectNamespace<TwentyState>;
  SCHEDULER_DO: DurableObjectNamespace<TwentyScheduler>;
  PUBSUB_DO: DurableObjectNamespace<TwentyPubSub>;
  EVENTS_QUEUE: Queue<WebhookMessage>;
  JOBS_QUEUE: Queue<CloudflareTwentyJob>;
  JOBS_DLQ: Queue;
  SERVER_URL: string;
  RELEASE_TOKEN: string;
}
