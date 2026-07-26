import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import type {
  JobExecutionBeginInput,
  JobExecutionBeginResult,
  JobExecutionCanaryResult,
  JobExecutionCompleteInput,
  JobExecutionFailureCode,
  JobExecutionQuarantineInput,
  JobExecutionOwnerInput,
  JobExecutionStartedInput,
  StateHealth,
  StateExpireInput,
  StateHashFieldInput,
  StateHashSetInput,
  StateIncrementInput,
  StateKeyInput,
  StateKeysInput,
  StateLockInput,
  StateLockResult,
  StateScanInput,
  StateScanResult,
  StateSetMemberInput,
  StateSetMembersInput,
  StateSetInput,
  StateCanaryDiagnostics,
  StateValueResult,
} from "./contracts";
import { lockClaimDisposition } from "./lock-policy";

interface ValueRow {
  [key: string]: string | number | null;
  value_json: string;
  expires_at: number | null;
  version: number;
}

interface LockRow {
  [key: string]: string | number;
  owner: string;
  fencing_token: number;
  expires_at: number;
}

interface CountRow {
  [key: string]: number;
  count: number;
}

interface AlarmRow {
  [key: string]: number | null;
  cleanup_at: number | null;
}

interface JobExecutionRow {
  [key: string]: string | number | null;
  status: string;
  owner: string;
  attempts: number;
  lease_expires_at: number | null;
  completed_at: number | null;
  failure_code: string | null;
}

function jobExecutionFailureCode(value: string | null): JobExecutionFailureCode {
  switch (value) {
    case "permanent-executor-response":
    case "retry-limit-exceeded":
    case "executor-outcome-ambiguous":
      return value;
    default:
      return "executor-outcome-ambiguous";
  }
}

/**
 * Strongly consistent state primitive for the Redis-free backend.
 *
 * Instances are sharded by the gateway. All mutation methods are synchronous
 * SQLite transactions inside one Durable Object, so lock and counter behavior
 * remains atomic without Redis Lua scripts.
 */
export class TwentyState extends DurableObject<Env> {
  private readonly canaryMode: boolean;
  private readonly incarnationId = crypto.randomUUID();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.canaryMode = env.CANARY_MODE === "true";
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS state_values (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        expires_at INTEGER,
        version INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (namespace, key)
      );
      CREATE INDEX IF NOT EXISTS state_values_expiry
        ON state_values (expires_at) WHERE expires_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS state_sets (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        member TEXT NOT NULL,
        PRIMARY KEY (namespace, key, member)
      );

      CREATE TABLE IF NOT EXISTS state_hashes (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (namespace, key, field)
      );

      CREATE TABLE IF NOT EXISTS state_lists (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        position INTEGER NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (namespace, key, position)
      );

      CREATE TABLE IF NOT EXISTS state_key_expiry (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, key)
      );
      CREATE INDEX IF NOT EXISTS state_key_expiry_time
        ON state_key_expiry (expires_at);

      CREATE TABLE IF NOT EXISTS state_locks (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        owner TEXT NOT NULL,
        fencing_token INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, key)
      );
      CREATE INDEX IF NOT EXISTS state_locks_expiry
        ON state_locks (expires_at);

      CREATE TABLE IF NOT EXISTS state_lock_fences (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        fencing_token INTEGER NOT NULL,
        PRIMARY KEY (namespace, key)
      );

      CREATE TABLE IF NOT EXISTS job_executions (
        job_id TEXT PRIMARY KEY,
        status TEXT NOT NULL
          CHECK(status IN ('reserved', 'running', 'completed', 'quarantined')),
        owner TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        lease_expires_at INTEGER,
        completed_at INTEGER,
        failure_code TEXT,
        retain_until INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS job_executions_retention
        ON job_executions (retain_until);
    `);
    this.migrateJobExecutionSchema();
  }

  private migrateJobExecutionSchema(): void {
    const table = this.ctx.storage.sql
      .exec<{ sql: string }>(
        `SELECT sql FROM sqlite_master
         WHERE type = 'table' AND name = 'job_executions'`,
      )
      .toArray()[0];
    if (
      table?.sql.includes("'reserved'") &&
      table?.sql.includes("'quarantined'") &&
      table.sql.includes("failure_code")
    )
      return;

    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DROP INDEX IF EXISTS job_executions_retention");
      this.ctx.storage.sql.exec(
        "ALTER TABLE job_executions RENAME TO job_executions_v2",
      );
      this.ctx.storage.sql.exec(`
        CREATE TABLE job_executions (
          job_id TEXT PRIMARY KEY,
          status TEXT NOT NULL
            CHECK(status IN ('reserved', 'running', 'completed', 'quarantined')),
          owner TEXT NOT NULL,
          attempts INTEGER NOT NULL,
          lease_expires_at INTEGER,
          completed_at INTEGER,
          failure_code TEXT,
          retain_until INTEGER NOT NULL
        )
      `);
      this.ctx.storage.sql.exec(`
        INSERT INTO job_executions (
          job_id, status, owner, attempts, lease_expires_at,
          completed_at, failure_code, retain_until
        )
        SELECT
          job_id, status, owner, attempts, lease_expires_at,
          completed_at, NULL, retain_until
        FROM job_executions_v2
      `);
      this.ctx.storage.sql.exec("DROP TABLE job_executions_v2");
      this.ctx.storage.sql.exec(
        `CREATE INDEX job_executions_retention
         ON job_executions (retain_until)`,
      );
    });
  }

  private deleteExpiredKey(input: StateKeyInput, now = Date.now()): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM state_values
       WHERE namespace = ? AND key = ?
         AND expires_at IS NOT NULL AND expires_at <= ?`,
      input.namespace,
      input.key,
      now,
    );
    const expired = this.ctx.storage.sql
      .exec<{ expires_at: number }>(
        `SELECT expires_at FROM state_key_expiry
         WHERE namespace = ? AND key = ? AND expires_at <= ?`,
        input.namespace,
        input.key,
        now,
      )
      .toArray()[0];
    if (expired) this.deleteCollectionKey(input);
  }

  private deleteCollectionKey(input: StateKeyInput): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM state_sets WHERE namespace = ? AND key = ?",
      input.namespace,
      input.key,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM state_hashes WHERE namespace = ? AND key = ?",
      input.namespace,
      input.key,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM state_lists WHERE namespace = ? AND key = ?",
      input.namespace,
      input.key,
    );
    this.ctx.storage.sql.exec(
      "DELETE FROM state_key_expiry WHERE namespace = ? AND key = ?",
      input.namespace,
      input.key,
    );
  }

  private deleteExpiredLock(input: StateKeyInput, now = Date.now()): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM state_locks
       WHERE namespace = ? AND key = ? AND expires_at <= ?`,
      input.namespace,
      input.key,
      now,
    );
  }

  private cleanupExpired(now = Date.now(), limit = 500): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM state_values WHERE rowid IN (
         SELECT rowid FROM state_values
         WHERE expires_at IS NOT NULL AND expires_at <= ?
         LIMIT ?
       )`,
      now,
      limit,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM job_executions WHERE rowid IN (
         SELECT rowid FROM job_executions
         WHERE status IN ('completed', 'quarantined') AND retain_until <= ?
         LIMIT ?
       )`,
      now,
      limit,
    );
    const expiredCollections = this.ctx.storage.sql
      .exec<{ namespace: string; key: string }>(
        `SELECT namespace, key FROM state_key_expiry
         WHERE expires_at <= ? LIMIT ?`,
        now,
        limit,
      )
      .toArray();
    for (const key of expiredCollections) this.deleteCollectionKey(key);
    this.ctx.storage.sql.exec(
      `DELETE FROM state_locks WHERE rowid IN (
         SELECT rowid FROM state_locks
         WHERE expires_at <= ?
         LIMIT ?
       )`,
      now,
      limit,
    );
  }

  private nextCleanupAt(): number | null {
    const row = this.ctx.storage.sql
      .exec<AlarmRow>(
        `SELECT MIN(expires_at) AS cleanup_at FROM (
           SELECT expires_at FROM state_values WHERE expires_at IS NOT NULL
           UNION ALL
           SELECT expires_at FROM state_key_expiry
           UNION ALL
           SELECT expires_at FROM state_locks
           UNION ALL
           SELECT retain_until FROM job_executions
           WHERE status IN ('completed', 'quarantined')
         )`,
      )
      .one();
    return row.cleanup_at;
  }

  private async scheduleCleanup(): Promise<void> {
    const cleanupAt = this.nextCleanupAt();
    if (cleanupAt === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.max(cleanupAt, Date.now() + 1_000));
  }

  async getValue(input: StateKeyInput): Promise<StateValueResult> {
    this.deleteExpiredKey(input);
    const row = this.ctx.storage.sql
      .exec<ValueRow>(
        `SELECT value_json, expires_at, version
         FROM state_values WHERE namespace = ? AND key = ?`,
        input.namespace,
        input.key,
      )
      .toArray()[0];
    if (!row) return { found: false };
    return {
      found: true,
      value: JSON.parse(row.value_json) as unknown,
      version: row.version,
      expiresAt: row.expires_at,
    };
  }

  async setValue(input: StateSetInput): Promise<StateValueResult> {
    const encoded = JSON.stringify(input.value);
    if (encoded === undefined) throw new Error("value is not JSON serializable");
    const expiresAt = input.ttlMs ? Date.now() + input.ttlMs : null;

    this.ctx.storage.transactionSync(() => {
      this.deleteCollectionKey(input);
      this.ctx.storage.sql.exec(
        `INSERT INTO state_values
         (namespace, key, value_json, expires_at, version)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(namespace, key) DO UPDATE SET
         value_json = excluded.value_json,
         expires_at = excluded.expires_at,
         version = state_values.version + 1`,
        input.namespace,
        input.key,
        encoded,
        expiresAt,
      );
    });
    await this.scheduleCleanup();
    return this.getValue(input);
  }

  async deleteValue(input: StateKeyInput): Promise<boolean> {
    let deleted = false;
    this.ctx.storage.transactionSync(() => {
      const value = this.ctx.storage.sql.exec(
        "DELETE FROM state_values WHERE namespace = ? AND key = ?",
        input.namespace,
        input.key,
      );
      const sets = this.ctx.storage.sql.exec(
        "DELETE FROM state_sets WHERE namespace = ? AND key = ?",
        input.namespace,
        input.key,
      );
      const hashes = this.ctx.storage.sql.exec(
        "DELETE FROM state_hashes WHERE namespace = ? AND key = ?",
        input.namespace,
        input.key,
      );
      const lists = this.ctx.storage.sql.exec(
        "DELETE FROM state_lists WHERE namespace = ? AND key = ?",
        input.namespace,
        input.key,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM state_key_expiry WHERE namespace = ? AND key = ?",
        input.namespace,
        input.key,
      );
      deleted =
        value.rowsWritten +
          sets.rowsWritten +
          hashes.rowsWritten +
          lists.rowsWritten >
        0;
    });
    await this.scheduleCleanup();
    return deleted;
  }

  async getValues(input: StateKeysInput): Promise<(unknown | null)[]> {
    const results: (unknown | null)[] = [];
    for (const key of input.keys) {
      const value = await this.getValue({ namespace: input.namespace, key });
      results.push(value.found ? value.value : null);
    }
    return results;
  }

  async deleteValues(input: StateKeysInput): Promise<number> {
    let deleted = 0;
    for (const key of input.keys)
      if (await this.deleteValue({ namespace: input.namespace, key })) deleted++;
    return deleted;
  }

  async expireKey(input: StateExpireInput): Promise<boolean> {
    this.deleteExpiredKey(input);
    const expiresAt = Date.now() + input.ttlMs;
    let found = false;
    this.ctx.storage.transactionSync(() => {
      const value = this.ctx.storage.sql.exec(
        `UPDATE state_values SET expires_at = ?
         WHERE namespace = ? AND key = ?`,
        expiresAt,
        input.namespace,
        input.key,
      );
      const collection = this.ctx.storage.sql
        .exec<{ count: number }>(
          `SELECT (
             EXISTS(SELECT 1 FROM state_sets WHERE namespace = ? AND key = ?) OR
             EXISTS(SELECT 1 FROM state_hashes WHERE namespace = ? AND key = ?) OR
             EXISTS(SELECT 1 FROM state_lists WHERE namespace = ? AND key = ?)
           ) AS count`,
          input.namespace,
          input.key,
          input.namespace,
          input.key,
          input.namespace,
          input.key,
        )
        .one().count;
      found = value.rowsWritten > 0 || collection > 0;
      if (collection > 0)
        this.ctx.storage.sql.exec(
          `INSERT INTO state_key_expiry (namespace, key, expires_at)
           VALUES (?, ?, ?)
           ON CONFLICT(namespace, key) DO UPDATE SET expires_at = excluded.expires_at`,
          input.namespace,
          input.key,
          expiresAt,
        );
    });
    await this.scheduleCleanup();
    return found;
  }

  async setAdd(input: StateSetMembersInput): Promise<number> {
    this.deleteExpiredKey(input);
    let added = 0;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM state_values WHERE namespace = ? AND key = ?",
        input.namespace,
        input.key,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM state_hashes WHERE namespace = ? AND key = ?",
        input.namespace,
        input.key,
      );
      for (const member of input.members) {
        const result = this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO state_sets (namespace, key, member)
           VALUES (?, ?, ?)`,
          input.namespace,
          input.key,
          member,
        );
        added += result.rowsWritten;
      }
    });
    return added;
  }

  async setRemove(input: StateSetMembersInput): Promise<number> {
    this.deleteExpiredKey(input);
    let removed = 0;
    for (const member of input.members)
      removed += this.ctx.storage.sql.exec(
        `DELETE FROM state_sets
         WHERE namespace = ? AND key = ? AND member = ?`,
        input.namespace,
        input.key,
        member,
      ).rowsWritten;
    return removed;
  }

  async setPop(input: StateKeyInput): Promise<string | null> {
    this.deleteExpiredKey(input);
    let member: string | null = null;
    this.ctx.storage.transactionSync(() => {
      const row = this.ctx.storage.sql
        .exec<{ member: string }>(
          `SELECT member FROM state_sets
           WHERE namespace = ? AND key = ? ORDER BY member LIMIT 1`,
          input.namespace,
          input.key,
        )
        .toArray()[0];
      if (!row) return;
      member = row.member;
      this.ctx.storage.sql.exec(
        `DELETE FROM state_sets
         WHERE namespace = ? AND key = ? AND member = ?`,
        input.namespace,
        input.key,
        row.member,
      );
    });
    return member;
  }

  async setCard(input: StateKeyInput): Promise<number> {
    this.deleteExpiredKey(input);
    return this.ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count FROM state_sets
         WHERE namespace = ? AND key = ?`,
        input.namespace,
        input.key,
      )
      .one().count;
  }

  async setMembers(input: StateKeyInput): Promise<string[]> {
    this.deleteExpiredKey(input);
    return this.ctx.storage.sql
      .exec<{ member: string }>(
        `SELECT member FROM state_sets
         WHERE namespace = ? AND key = ? ORDER BY member`,
        input.namespace,
        input.key,
      )
      .toArray()
      .map(({ member }) => member);
  }

  async hashValues(input: StateKeyInput): Promise<string[]> {
    this.deleteExpiredKey(input);
    return this.ctx.storage.sql
      .exec<{ value: string }>(
        `SELECT value FROM state_hashes
         WHERE namespace = ? AND key = ? ORDER BY field`,
        input.namespace,
        input.key,
      )
      .toArray()
      .map(({ value }) => value);
  }

  async hashSet(input: StateHashSetInput): Promise<number> {
    this.deleteExpiredKey(input);
    let changed = 0;
    this.ctx.storage.transactionSync(() => {
      if (input.onlyIfKeyExists) {
        const exists = this.ctx.storage.sql
          .exec<CountRow>(
            `SELECT COUNT(*) AS count FROM state_hashes
             WHERE namespace = ? AND key = ?`,
            input.namespace,
            input.key,
          )
          .one().count;
        if (exists === 0) return;
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM state_values WHERE namespace = ? AND key = ?",
        input.namespace,
        input.key,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM state_sets WHERE namespace = ? AND key = ?",
        input.namespace,
        input.key,
      );
      const result = this.ctx.storage.sql.exec(
        `INSERT INTO state_hashes (namespace, key, field, value)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(namespace, key,field) DO UPDATE SET value = excluded.value`,
        input.namespace,
        input.key,
        input.field,
        input.value,
      );
      changed = result.rowsWritten;
      if (input.ttlMs) {
        const expiresAt = Date.now() + input.ttlMs;
        this.ctx.storage.sql.exec(
          `INSERT INTO state_key_expiry (namespace, key, expires_at)
           VALUES (?, ?, ?)
           ON CONFLICT(namespace, key) DO UPDATE SET expires_at = excluded.expires_at`,
          input.namespace,
          input.key,
          expiresAt,
        );
      }
    });
    if (input.ttlMs) await this.scheduleCleanup();
    return changed;
  }

  async hashDelete(input: StateHashFieldInput): Promise<boolean> {
    this.deleteExpiredKey(input);
    return this.ctx.storage.sql.exec(
      `DELETE FROM state_hashes
       WHERE namespace = ? AND key = ? AND field = ?`,
      input.namespace,
      input.key,
      input.field,
    ).rowsWritten > 0;
  }

  async listAppend(
    input: StateKeyInput & { value: string },
  ): Promise<number> {
    this.deleteExpiredKey(input);
    let length = 0;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "DELETE FROM state_values WHERE namespace = ? AND key = ?",
        input.namespace,
        input.key,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM state_sets WHERE namespace = ? AND key = ?",
        input.namespace,
        input.key,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM state_hashes WHERE namespace = ? AND key = ?",
        input.namespace,
        input.key,
      );
      const last = this.ctx.storage.sql
        .exec<{ position: number | null }>(
          `SELECT MAX(position) AS position FROM state_lists
           WHERE namespace = ? AND key = ?`,
          input.namespace,
          input.key,
        )
        .one().position;
      this.ctx.storage.sql.exec(
        `INSERT INTO state_lists (namespace, key, position, value)
         VALUES (?, ?, ?, ?)`,
        input.namespace,
        input.key,
        (last ?? -1) + 1,
        input.value,
      );
      length = this.ctx.storage.sql
        .exec<CountRow>(
          `SELECT COUNT(*) AS count FROM state_lists
           WHERE namespace = ? AND key = ?`,
          input.namespace,
          input.key,
        )
        .one().count;
    });
    return length;
  }

  async listRange(input: StateKeyInput): Promise<string[]> {
    this.deleteExpiredKey(input);
    return this.ctx.storage.sql
      .exec<{ value: string }>(
        `SELECT value FROM state_lists
         WHERE namespace = ? AND key = ? ORDER BY position`,
        input.namespace,
        input.key,
      )
      .toArray()
      .map(({ value }) => value);
  }

  async scanKeys(input: StateScanInput): Promise<StateScanResult> {
    this.cleanupExpired();
    const like = input.pattern
      .replace(/[\\%_]/g, "\\$&")
      .replace(/\*/g, "%")
      .replace(/\?/g, "_");
    const rows = this.ctx.storage.sql
      .exec<{ key: string }>(
        `SELECT DISTINCT key FROM (
           SELECT key FROM state_values WHERE namespace = ?
           UNION ALL SELECT key FROM state_sets WHERE namespace = ?
           UNION ALL SELECT key FROM state_hashes WHERE namespace = ?
           UNION ALL SELECT key FROM state_lists WHERE namespace = ?
         )
         WHERE key LIKE ? ESCAPE '\\' AND key > ?
         ORDER BY key LIMIT ?`,
        input.namespace,
        input.namespace,
        input.namespace,
        input.namespace,
        like,
        input.after ?? "",
        input.limit,
      )
      .toArray();
    const keys = rows.map(({ key }) => key);
    return {
      keys,
      ...(keys.length === input.limit
        ? { nextAfter: keys[keys.length - 1] }
        : {}),
    };
  }

  async clearNamespace(namespace: string): Promise<number> {
    let deleted = 0;
    this.ctx.storage.transactionSync(() => {
      for (const table of [
        "state_values",
        "state_sets",
        "state_hashes",
        "state_lists",
      ]) {
        const result = this.ctx.storage.sql.exec(
          `DELETE FROM ${table} WHERE namespace = ?`,
          namespace,
        );
        deleted += result.rowsWritten;
      }
      this.ctx.storage.sql.exec(
        "DELETE FROM state_key_expiry WHERE namespace = ?",
        namespace,
      );
    });
    await this.scheduleCleanup();
    return deleted;
  }

  async increment(input: StateIncrementInput): Promise<StateValueResult> {
    const now = Date.now();
    const expiresAt = input.ttlMs ? now + input.ttlMs : null;
    let result: StateValueResult = { found: false };

    this.ctx.storage.transactionSync(() => {
      this.deleteExpiredKey(input, now);
      const current = this.ctx.storage.sql
        .exec<ValueRow>(
          `SELECT value_json, expires_at, version FROM state_values
           WHERE namespace = ? AND key = ?`,
          input.namespace,
          input.key,
        )
        .toArray()[0];
      const currentValue = current
        ? (JSON.parse(current.value_json) as unknown)
        : 0;
      if (typeof currentValue !== "number" || !Number.isFinite(currentValue))
        throw new Error("state value is not a finite number");
      const value = currentValue + input.delta;
      if (!Number.isSafeInteger(value))
        throw new Error("increment exceeds safe integer range");
      const version = (current?.version ?? 0) + 1;
      const nextExpiry =
        input.ttlMs === undefined ? (current?.expires_at ?? null) : expiresAt;
      this.ctx.storage.sql.exec(
        `INSERT INTO state_values
           (namespace, key, value_json, expires_at, version)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(namespace, key) DO UPDATE SET
           value_json = excluded.value_json,
           expires_at = excluded.expires_at,
           version = excluded.version`,
        input.namespace,
        input.key,
        JSON.stringify(value),
        nextExpiry,
        version,
      );
      result = {
        found: true,
        value,
        version,
        expiresAt: nextExpiry,
      };
    });

    await this.scheduleCleanup();
    return result;
  }

  async acquireLock(input: StateLockInput): Promise<StateLockResult> {
    const now = Date.now();
    const expiresAt = now + input.ttlMs;
    let result: StateLockResult = { acquired: false };

    this.ctx.storage.transactionSync(() => {
      this.deleteExpiredLock(input, now);
      const existing = this.ctx.storage.sql
        .exec<LockRow>(
          `SELECT owner, fencing_token, expires_at FROM state_locks
           WHERE namespace = ? AND key = ?`,
          input.namespace,
          input.key,
        )
        .toArray()[0];
      const disposition = lockClaimDisposition(existing?.owner, input.owner);
      if (disposition === "renew") {
        this.ctx.storage.sql.exec(
          `UPDATE state_locks SET expires_at = ?
           WHERE namespace = ? AND key = ? AND owner = ?`,
          expiresAt,
          input.namespace,
          input.key,
          input.owner,
        );
        result = {
          acquired: true,
          fencingToken: existing.fencing_token,
          expiresAt,
        };
        return;
      }
      if (disposition === "busy") return;

      this.ctx.storage.sql.exec(
        `INSERT INTO state_lock_fences (namespace, key, fencing_token)
         VALUES (?, ?, 1)
         ON CONFLICT(namespace, key) DO UPDATE SET
           fencing_token = state_lock_fences.fencing_token + 1`,
        input.namespace,
        input.key,
      );
      const fence = this.ctx.storage.sql
        .exec<{ fencing_token: number }>(
          `SELECT fencing_token FROM state_lock_fences
           WHERE namespace = ? AND key = ?`,
          input.namespace,
          input.key,
        )
        .one().fencing_token;
      this.ctx.storage.sql.exec(
        `INSERT INTO state_locks
           (namespace, key, owner, fencing_token, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
        input.namespace,
        input.key,
        input.owner,
        fence,
        expiresAt,
      );
      result = { acquired: true, fencingToken: fence, expiresAt };
    });

    await this.scheduleCleanup();
    return result;
  }

  async releaseLock(input: Omit<StateLockInput, "ttlMs">): Promise<boolean> {
    this.deleteExpiredLock(input);
    const result = this.ctx.storage.sql.exec(
      `DELETE FROM state_locks
       WHERE namespace = ? AND key = ? AND owner = ?`,
      input.namespace,
      input.key,
      input.owner,
    );
    await this.scheduleCleanup();
    return result.rowsWritten > 0;
  }

  async beginJobExecution(
    input: JobExecutionBeginInput,
  ): Promise<JobExecutionBeginResult> {
    const now = Date.now();
    const leaseExpiresAt = now + input.leaseMs;
    let result: JobExecutionBeginResult = {
      disposition: "started",
      attempts: 1,
      leaseExpiresAt,
    };

    this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<JobExecutionRow>(
          `SELECT status, owner, attempts, lease_expires_at, completed_at,
                  failure_code
           FROM job_executions WHERE job_id = ?`,
          input.jobId,
        )
        .toArray()[0];
      if (existing?.status === "completed") {
        result = {
          disposition: "completed",
          attempts: existing.attempts,
          ...(existing.completed_at !== null
            ? { completedAt: existing.completed_at }
            : {}),
        };
        return;
      }
      if (existing?.status === "quarantined") {
        result = {
          disposition: "quarantined",
          attempts: existing.attempts,
          failureCode: jobExecutionFailureCode(existing.failure_code),
        };
        return;
      }
      if (
        (existing?.status === "reserved" ||
          existing?.status === "running") &&
        existing.lease_expires_at !== null &&
        existing.lease_expires_at > now
      ) {
        result = {
          disposition: "busy",
          attempts: existing.attempts,
          leaseExpiresAt: existing.lease_expires_at,
        };
        return;
      }
      if (existing?.status === "reserved") {
        this.ctx.storage.sql.exec(
          `DELETE FROM job_executions
           WHERE job_id = ? AND status = 'reserved'`,
          input.jobId,
        );
      }
      if (existing?.status === "running") {
        const retainUntil = now + input.retentionMs;
        this.ctx.storage.sql.exec(
          `UPDATE job_executions SET
             status = 'quarantined',
             lease_expires_at = NULL,
             completed_at = NULL,
             failure_code = 'executor-outcome-ambiguous',
             retain_until = ?
           WHERE job_id = ? AND status = 'running'`,
          retainUntil,
          input.jobId,
        );
        result = {
          disposition: "quarantined",
          attempts: existing.attempts,
          failureCode: "executor-outcome-ambiguous",
        };
        return;
      }

      const attempts = (existing?.attempts ?? 0) + 1;
      this.ctx.storage.sql.exec(
        `INSERT INTO job_executions (
           job_id, status, owner, attempts, lease_expires_at,
           completed_at, retain_until
         ) VALUES (?, 'reserved', ?, ?, ?, NULL, ?)
         ON CONFLICT(job_id) DO UPDATE SET
           status = 'reserved',
           owner = excluded.owner,
           attempts = excluded.attempts,
           lease_expires_at = excluded.lease_expires_at,
           completed_at = NULL,
           failure_code = NULL,
           retain_until = excluded.retain_until`,
        input.jobId,
        input.owner,
        attempts,
        leaseExpiresAt,
        leaseExpiresAt,
      );
      result = { disposition: "started", attempts, leaseExpiresAt };
    });

    await this.scheduleCleanup();
    return result;
  }

  async markJobExecutionStarted(
    input: JobExecutionStartedInput,
  ): Promise<boolean> {
    const result = this.ctx.storage.sql.exec(
      `UPDATE job_executions SET status = 'running'
       WHERE job_id = ? AND status = 'reserved' AND owner = ?`,
      input.jobId,
      input.owner,
    );
    return result.rowsWritten > 0;
  }

  async completeJobExecution(
    input: JobExecutionCompleteInput,
  ): Promise<boolean> {
    const now = Date.now();
    const result = this.ctx.storage.sql.exec(
      `UPDATE job_executions SET
         status = 'completed',
         lease_expires_at = NULL,
         completed_at = ?,
         retain_until = ?
       WHERE job_id = ? AND status IN ('reserved', 'running') AND owner = ?`,
      now,
      now + input.retentionMs,
      input.jobId,
      input.owner,
    );
    await this.scheduleCleanup();
    return result.rowsWritten > 0;
  }

  async abandonReservedJobExecution(
    input: JobExecutionOwnerInput,
  ): Promise<boolean> {
    const result = this.ctx.storage.sql.exec(
      `DELETE FROM job_executions
       WHERE job_id = ? AND status = 'reserved' AND owner = ?`,
      input.jobId,
      input.owner,
    );
    return result.rowsWritten > 0;
  }

  async abandonJobExecution(input: JobExecutionOwnerInput): Promise<boolean> {
    const result = this.ctx.storage.sql.exec(
      `DELETE FROM job_executions
       WHERE job_id = ? AND status IN ('reserved', 'running') AND owner = ?`,
      input.jobId,
      input.owner,
    );
    return result.rowsWritten > 0;
  }

  async quarantineJobExecution(
    input: JobExecutionQuarantineInput,
  ): Promise<boolean> {
    const now = Date.now();
    const result = this.ctx.storage.sql.exec(
      `UPDATE job_executions SET
         status = 'quarantined',
         lease_expires_at = NULL,
         completed_at = NULL,
         failure_code = ?,
         retain_until = ?
       WHERE job_id = ? AND status IN ('reserved', 'running') AND owner = ?`,
      input.failureCode,
      now + input.retentionMs,
      input.jobId,
      input.owner,
    );
    await this.scheduleCleanup();
    return result.rowsWritten > 0;
  }

  async jobExecutionForCanary(
    jobId: string,
  ): Promise<JobExecutionCanaryResult> {
    if (!this.canaryMode) throw new Error("canary diagnostics disabled");
    const row = this.ctx.storage.sql
      .exec<JobExecutionRow>(
        `SELECT status, owner, attempts, lease_expires_at, completed_at,
                failure_code
         FROM job_executions WHERE job_id = ?`,
        jobId,
      )
      .toArray()[0];
    if (!row) return { found: false };
    return {
      found: true,
      status: row.status,
      attempts: row.attempts,
      leaseExpiresAt: row.lease_expires_at,
      completedAt: row.completed_at,
      ...(row.failure_code !== null
        ? { failureCode: jobExecutionFailureCode(row.failure_code) }
        : {}),
    };
  }

  async health(): Promise<StateHealth> {
    this.cleanupExpired();
    const values = this.ctx.storage.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM state_values")
      .one().count;
    const sets = this.ctx.storage.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM state_sets")
      .one().count;
    const hashes = this.ctx.storage.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM state_hashes")
      .one().count;
    const lists = this.ctx.storage.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM state_lists")
      .one().count;
    const locks = this.ctx.storage.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM state_locks")
      .one().count;
    const jobExecutions = this.ctx.storage.sql
      .exec<CountRow>("SELECT COUNT(*) AS count FROM job_executions")
      .one().count;
    return {
      status: "ok",
      values,
      sets,
      hashes,
      lists,
      locks,
      jobExecutions,
      nextCleanupAt: this.nextCleanupAt(),
    };
  }

  async diagnosticsForCanary(
    namespace: string,
  ): Promise<StateCanaryDiagnostics> {
    if (!this.canaryMode) throw new Error("canary diagnostics disabled");
    const now = Date.now();
    const count = (table: string): number =>
      this.ctx.storage.sql
        .exec<CountRow>(
          `SELECT COUNT(*) AS count FROM ${table} WHERE namespace = ?`,
          namespace,
        )
        .one().count;
    const countExpired = (table: string, column: string): number =>
      this.ctx.storage.sql
        .exec<CountRow>(
          `SELECT COUNT(*) AS count FROM ${table}
           WHERE namespace = ? AND ${column} <= ?`,
          namespace,
          now,
        )
        .one().count;

    return {
      incarnationId: this.incarnationId,
      namespace,
      values: count("state_values"),
      sets: count("state_sets"),
      hashes: count("state_hashes"),
      lists: count("state_lists"),
      keyExpiries: count("state_key_expiry"),
      locks: count("state_locks"),
      lockFences: count("state_lock_fences"),
      expiredValues: countExpired("state_values", "expires_at"),
      expiredCollections: countExpired("state_key_expiry", "expires_at"),
      expiredLocks: countExpired("state_locks", "expires_at"),
      alarmAt: await this.ctx.storage.getAlarm(),
    };
  }

  async alarm(): Promise<void> {
    this.cleanupExpired();
    await this.scheduleCleanup();
  }
}
