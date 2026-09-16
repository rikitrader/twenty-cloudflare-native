import type {
  TwentyBackup,
  TwentyServer,
  TwentyWorker,
} from "./containers";
import type { TwentyState } from "./cloudflare-state/state-do";
import type { TwentyScheduler } from "./schedule-do";
import type { TwentyPubSub } from "./pubsub-do";
import type { JobExecutionFailureCode } from "./cloudflare-state/contracts";

export interface Env {
  // Production is permanently Neon-backed and Redis-free.
  TWENTY_SERVER: DurableObjectNamespace<TwentyServer>;
  TWENTY_WORKER: DurableObjectNamespace<TwentyWorker>;
  BACKUP_CONTAINER: DurableObjectNamespace<TwentyBackup>;
  // Redis-free state, schedule, and pub/sub Durable Objects.
  STATE_DO: DurableObjectNamespace<TwentyState>;
  SCHEDULER_DO: DurableObjectNamespace<TwentyScheduler>;
  PUBSUB_DO: DurableObjectNamespace<TwentyPubSub>;
  // Hyperdrive is available to Worker-runtime database operations. Cloudflare
  // scopes its generated endpoint to the Worker runtime, so Containers use the
  // separately encrypted PG_DATABASE_URL origin credential below.
  HYPERDRIVE?: Hyperdrive;
  CF_VERSION_METADATA?: {
    id: string;
    tag?: string;
    timestamp?: string;
  };
  STATUS_KV: KVNamespace;
  STORAGE: R2Bucket;
  OPS_DB: D1Database;
  /** D1 database containing Cloudflare-native CRM records. */
  CRM_DB?: D1Database;
  OPS_RATE_LIMITER?: RateLimit;
  OPS_ALERT_EMAIL?: SendEmail;
  EVENTS_QUEUE: Queue<WebhookMessage>;
  JOBS_QUEUE: Queue<CloudflareTwentyJob>;
  CANARY_QUEUE?: Queue<CloudflareTwentyJob>;
  JOBS_DLQ: Queue<CloudflareJobFailure>;
  BACKUP_WF: Workflow;
  CRM_EXPORT_WF?: Workflow;
  SERVER_URL: string;
  // Secrets. ENCRYPTION_KEY is Twenty's primary secret; APP_SECRET is legacy.
  ENCRYPTION_KEY?: string;
  FALLBACK_ENCRYPTION_KEY?: string;
  APP_SECRET?: string;
  BACKUP_TOKEN?: string;
  WEBHOOK_TOKEN?: string;
  INTERNAL_SERVICE_TOKEN?: string;
  // Compatibility flag consumed by the upstream adapter patch. Cloudflare is
  // the only supported value; Redis is not a deployment or rollback option.
  REDIS_BACKEND?: "cloudflare";
  CLOUDFLARE_PUBSUB_TRANSPORT?: "websocket" | "poll";
  CLOUDFLARE_QUEUE_DRAIN?: string;
  // Isolated validation mode: never restore production R2 backups.
  CANARY_MODE?: string;
  CANARY_TOKEN?: string;
  OPS_TOKEN?: string;
  ACCESS_REQUIRED?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ACCESS_ALLOWED_GROUPS?: string;
  OPS_ALERT_FROM?: string;
  OPS_ALERT_TO?: string;
  JOB_QUEUE_NAME?: string;
  JOB_DLQ_NAME?: string;
  CANARY_QUEUE_NAME?: string;
  SERVER_REPLICAS?: string;
  WORKER_REPLICAS?: string;
  // PostgreSQL plus the selected coordination backend enables external mode.
  PG_DATABASE_URL?: string; // Neon/Supabase (optionally via Hyperdrive)
  /** Enables the native D1 CRM vertical slice during migration. */
  D1_NATIVE_MODE?: string;
  PG_POOL_MAX_CONNECTIONS?: string;
  // R2 via Twenty's native S3 driver. Upstream names take precedence;
  // AWS_* kept as aliases for older credential chains.
  STORAGE_S3_ENDPOINT?: string; // https://<account_id>.r2.cloudflarestorage.com
  STORAGE_S3_NAME?: string;
  STORAGE_S3_REGION?: string;
  STORAGE_S3_ACCESS_KEY_ID?: string;
  STORAGE_S3_SECRET_ACCESS_KEY?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
}

export interface WebhookMessage {
  type: string;
  payload: string;
  receivedAt: string;
}

export interface CloudflareTwentyJob {
  schemaVersion: 1;
  id: string;
  queueName: string;
  jobName: string;
  data: unknown;
  createdAt: string;
  retryLimit: number;
  priority: number;
  notBefore?: number;
  dedupeKey?: string;
  dedupeClaimed?: boolean;
  retainDedupe?: boolean;
  replayOfFailureId?: string;
}

export interface CloudflareJobFailure {
  schemaVersion: 1;
  failureId: string;
  job: unknown;
  reason:
    | JobExecutionFailureCode
    | "invalid-queue-envelope"
    | "platform-retry-exhausted";
  failedAt: string;
  source: "application" | "platform";
}

export const externalMode = (env: Env): boolean =>
  Boolean(
    env.PG_DATABASE_URL &&
      env.REDIS_BACKEND === "cloudflare" &&
      env.INTERNAL_SERVICE_TOKEN,
  );

export const nativeD1Mode = (env: Env): boolean =>
  env.D1_NATIVE_MODE === "true" && Boolean(env.CRM_DB);

/** Compatibility status field: Cloudflare is the sole coordination backend. */
export const redisBackend = (_env: Env): "cloudflare" => "cloudflare";

/** Production has exactly one supported runtime topology. */
export const deploymentMode = (env: Env): string =>
  nativeD1Mode(env) ? "cloudflare-d1" : externalMode(env) ? "external-db" : "misconfigured";

/** Production fails closed instead of silently starting a Redis fallback. */
export const cloudflareBackendMisconfigured = (env: Env): boolean =>
  env.CANARY_MODE !== "true" && !externalMode(env) && !nativeD1Mode(env);
