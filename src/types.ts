import type { TwentyContainer, TwentyServer, TwentyWorker } from "./containers";

export interface Env {
  // Demo mode: wrapper image over the official all-in-one (adds backup agent).
  TWENTY: DurableObjectNamespace<TwentyContainer>;
  // External-DB mode: stock image, one class per process (mirrors upstream compose).
  TWENTY_SERVER: DurableObjectNamespace<TwentyServer>;
  TWENTY_WORKER: DurableObjectNamespace<TwentyWorker>;
  STATUS_KV: KVNamespace;
  STORAGE: R2Bucket;
  OPS_DB: D1Database;
  EVENTS_QUEUE: Queue<WebhookMessage>;
  BACKUP_WF: Workflow;
  SERVER_URL: string;
  // Secrets. ENCRYPTION_KEY is Twenty's primary secret; APP_SECRET is legacy.
  ENCRYPTION_KEY?: string;
  FALLBACK_ENCRYPTION_KEY?: string;
  APP_SECRET?: string;
  BACKUP_TOKEN?: string;
  WEBHOOK_TOKEN?: string;
  // One-shot: set true to force Twenty's migration/seed against a fresh Neon DB.
  RUN_NEON_INIT?: string;
  // Setting both flips routing to external-DB mode on the next request.
  PG_DATABASE_URL?: string; // Neon/Supabase (optionally via Hyperdrive)
  REDIS_URL?: string; // Upstash (rediss://)
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

export const externalMode = (env: Env): boolean =>
  Boolean(env.PG_DATABASE_URL && env.REDIS_URL);

/** Labels /_status: full external | hybrid (Neon PG + in-container Redis) | demo. */
export const deploymentMode = (env: Env): string =>
  externalMode(env)
    ? "external-db"
    : env.PG_DATABASE_URL
      ? "hybrid-neon"
      : "all-in-one";
