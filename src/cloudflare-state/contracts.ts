export const STATE_GATEWAY_HOST = "twenty-state.internal";
export const STATE_GATEWAY_MAX_BODY_BYTES = 1_000_000;
export const STATE_KEY_MAX_LENGTH = 512;
export const STATE_NAMESPACE_MAX_LENGTH = 128;
export const STATE_SHARD_MAX_LENGTH = 128;
export const STATE_MAX_TTL_MS = 365 * 24 * 60 * 60_000;
export const STATE_BATCH_MAX_ITEMS = 1_000;
export const STATE_SCAN_MAX_ITEMS = 1_000;

export interface StateKeyInput {
  namespace: string;
  key: string;
}

export interface StateSetInput extends StateKeyInput {
  value: unknown;
  ttlMs?: number;
}

export interface StateIncrementInput extends StateKeyInput {
  delta: number;
  ttlMs?: number;
}

export interface StateKeysInput {
  namespace: string;
  keys: string[];
}

export interface StateExpireInput extends StateKeyInput {
  ttlMs: number;
}

export interface StateSetMemberInput extends StateKeyInput {
  member: string;
}

export interface StateSetMembersInput extends StateKeyInput {
  members: string[];
}

export interface StateHashFieldInput extends StateKeyInput {
  field: string;
}

export interface StateHashSetInput extends StateHashFieldInput {
  value: string;
  onlyIfKeyExists?: boolean;
  ttlMs?: number;
}

export interface StateScanInput {
  namespace: string;
  pattern: string;
  after?: string;
  limit: number;
}

export interface StateScanResult {
  keys: string[];
  nextAfter?: string;
}

export interface StateLockInput extends StateKeyInput {
  owner: string;
  ttlMs: number;
}

export interface StateValueResult {
  found: boolean;
  value?: unknown;
  version?: number;
  expiresAt?: number | null;
}

export interface StateLockResult {
  acquired: boolean;
  fencingToken?: number;
  expiresAt?: number;
}

export interface JobExecutionBeginInput {
  jobId: string;
  owner: string;
  leaseMs: number;
  retentionMs: number;
}

export interface JobExecutionBeginResult {
  disposition: "started" | "busy" | "completed" | "quarantined";
  attempts: number;
  leaseExpiresAt?: number;
  completedAt?: number;
  failureCode?: JobExecutionFailureCode;
}

export interface JobExecutionCanaryResult {
  found: boolean;
  status?: string;
  attempts?: number;
  leaseExpiresAt?: number | null;
  completedAt?: number | null;
  failureCode?: JobExecutionFailureCode;
}

export interface JobExecutionOwnerInput {
  jobId: string;
  owner: string;
}

export type JobExecutionStartedInput = JobExecutionOwnerInput;

export interface JobExecutionCompleteInput extends JobExecutionOwnerInput {
  retentionMs: number;
}

export type JobExecutionFailureCode =
  | "executor-outcome-ambiguous"
  | "permanent-executor-response"
  | "retry-limit-exceeded";

export interface JobExecutionQuarantineInput
  extends JobExecutionCompleteInput {
  failureCode: JobExecutionFailureCode;
}

export interface StateHealth {
  status: "ok";
  values: number;
  sets: number;
  hashes: number;
  lists: number;
  locks: number;
  jobExecutions: number;
  nextCleanupAt: number | null;
}

export interface StateCanaryDiagnostics {
  incarnationId: string;
  namespace: string;
  values: number;
  sets: number;
  hashes: number;
  lists: number;
  keyExpiries: number;
  locks: number;
  lockFences: number;
  expiredValues: number;
  expiredCollections: number;
  expiredLocks: number;
  alarmAt: number | null;
}

export function validStateName(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[a-zA-Z0-9:_./-]+$/.test(value)
  );
}

export function validStateKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= STATE_KEY_MAX_LENGTH &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function validStateKeys(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= STATE_BATCH_MAX_ITEMS &&
    value.every(validStateKey)
  );
}

export function validTtl(ttlMs: unknown, required = false): ttlMs is number {
  if (ttlMs === undefined) return !required;
  return (
    typeof ttlMs === "number" &&
    Number.isSafeInteger(ttlMs) &&
    ttlMs > 0 &&
    ttlMs <= STATE_MAX_TTL_MS
  );
}

export function stateShardName(value: string): string {
  if (!validStateName(value, STATE_SHARD_MAX_LENGTH))
    throw new Error("invalid state shard");
  return value;
}
