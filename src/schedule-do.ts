import { DurableObject } from "cloudflare:workers";
import type { CloudflareTwentyJob, Env } from "./types";
import {
  dateMs,
  nextOccurrence,
  scheduleOccurrenceIdentity,
  type ScheduleInput,
} from "./schedule";

interface ScheduleRow {
  [key: string]: string | number | null;
  schedule_id: string;
  queue_name: string;
  job_name: string;
  data_json: string;
  retry_limit: number;
  priority: number;
  pattern: string | null;
  every_ms: number | null;
  timezone: string | null;
  end_date: number | null;
  next_run_at: number;
}

interface NextRow {
  [key: string]: number | null;
  next_run_at: number | null;
}

export class TwentyScheduler extends DurableObject<Env> {
  private readonly canaryMode: boolean;
  private readonly incarnationId = crypto.randomUUID();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.canaryMode = env.CANARY_MODE === "true";
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS schedules (
        schedule_id TEXT PRIMARY KEY,
        queue_name TEXT NOT NULL,
        job_name TEXT NOT NULL,
        data_json TEXT NOT NULL,
        retry_limit INTEGER NOT NULL,
        priority INTEGER NOT NULL,
        pattern TEXT,
        every_ms INTEGER,
        timezone TEXT,
        end_date INTEGER,
        next_run_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS schedules_next_run
        ON schedules (next_run_at);
    `);
  }

  private async setNextAlarm(): Promise<void> {
    const next = this.ctx.storage.sql
      .exec<NextRow>("SELECT MIN(next_run_at) AS next_run_at FROM schedules")
      .one().next_run_at;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1_000));
  }

  async upsert(input: ScheduleInput): Promise<{ nextRunAt: number }> {
    if (
      !input.scheduleId ||
      input.scheduleId.length > 450 ||
      !input.queueName ||
      input.queueName.length > 128 ||
      !input.jobName ||
      input.jobName.length > 256 ||
      !Number.isSafeInteger(input.retryLimit) ||
      input.retryLimit < 0 ||
      input.retryLimit > 10 ||
      !Number.isSafeInteger(input.priority) ||
      (input.pattern !== undefined &&
        (typeof input.pattern !== "string" || input.pattern.length > 256)) ||
      (input.timezone !== undefined &&
        (typeof input.timezone !== "string" || input.timezone.length > 128))
    )
      throw new Error("invalid schedule identity");
    const encoded = JSON.stringify(input.data);
    if (encoded === undefined) throw new Error("schedule data is not serializable");
    const nextRunAt = nextOccurrence(input, Date.now());
    if (nextRunAt === null) throw new Error("schedule has no future occurrence");
    this.ctx.storage.sql.exec(
      `INSERT INTO schedules (
         schedule_id, queue_name, job_name, data_json, retry_limit, priority,
         pattern, every_ms, timezone, end_date, next_run_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(schedule_id) DO UPDATE SET
         queue_name = excluded.queue_name,
         job_name = excluded.job_name,
         data_json = excluded.data_json,
         retry_limit = excluded.retry_limit,
         priority = excluded.priority,
         pattern = excluded.pattern,
         every_ms = excluded.every_ms,
         timezone = excluded.timezone,
         end_date = excluded.end_date,
         next_run_at = excluded.next_run_at`,
      input.scheduleId,
      input.queueName,
      input.jobName,
      encoded,
      input.retryLimit,
      input.priority,
      input.pattern ?? null,
      input.everyMs ?? null,
      input.timezone ?? null,
      dateMs(input.endDate) ?? null,
      nextRunAt,
    );
    await this.setNextAlarm();
    return { nextRunAt };
  }

  async remove(scheduleId: string): Promise<boolean> {
    const result = this.ctx.storage.sql.exec(
      "DELETE FROM schedules WHERE schedule_id = ?",
      scheduleId,
    );
    await this.setNextAlarm();
    return result.rowsWritten > 0;
  }

  private async jobForOccurrence(
    row: ScheduleRow,
    occurrence: number,
  ): Promise<CloudflareTwentyJob> {
    const identity = await scheduleOccurrenceIdentity(
      row.schedule_id,
      occurrence,
    );
    return {
      schemaVersion: 1,
      id: identity.jobId,
      queueName: row.queue_name,
      jobName: row.job_name,
      data: JSON.parse(row.data_json) as unknown,
      createdAt: new Date().toISOString(),
      retryLimit: row.retry_limit,
      priority: row.priority,
      dedupeKey: identity.dedupeKey,
      dedupeClaimed: false,
      retainDedupe: true,
    };
  }

  private queueFor(row: ScheduleRow): Queue<CloudflareTwentyJob> {
    if (
      this.canaryMode &&
      row.queue_name === "__cloudflare_canary__" &&
      row.job_name === "scheduler-ping"
    ) {
      if (!this.env.CANARY_QUEUE)
        throw new Error("canary queue not configured");
      return this.env.CANARY_QUEUE;
    }
    return this.env.JOBS_QUEUE;
  }

  async seedPastDueForCanary(
    runId: string,
  ): Promise<{ scheduleId: string; occurrence: number; jobId: string }> {
    if (!this.canaryMode) throw new Error("canary scheduler probe disabled");
    if (
      runId.length < 8 ||
      runId.length > 64 ||
      !/^[a-zA-Z0-9-]+$/.test(runId)
    )
      throw new Error("invalid canary run id");
    const scheduleId = `canary-g5-${runId}`;
    const occurrence = Date.now() - 5_000;
    const identity = await scheduleOccurrenceIdentity(scheduleId, occurrence);
    this.ctx.storage.sql.exec(
      `INSERT INTO schedules (
         schedule_id, queue_name, job_name, data_json, retry_limit, priority,
         pattern, every_ms, timezone, end_date, next_run_at
       ) VALUES (?, '__cloudflare_canary__', 'scheduler-ping', ?, 0, 5,
                 NULL, 1000, NULL, ?, ?)
       ON CONFLICT(schedule_id) DO UPDATE SET
         queue_name = excluded.queue_name,
         job_name = excluded.job_name,
         data_json = excluded.data_json,
         retry_limit = excluded.retry_limit,
         priority = excluded.priority,
         pattern = excluded.pattern,
         every_ms = excluded.every_ms,
         timezone = excluded.timezone,
         end_date = excluded.end_date,
         next_run_at = excluded.next_run_at`,
      scheduleId,
      JSON.stringify({ runId, scenario: "missed-alarm-and-duplicate" }),
      occurrence,
      occurrence,
    );
    await this.setNextAlarm();
    return { scheduleId, occurrence, jobId: identity.jobId };
  }

  async duplicateOccurrenceForCanary(scheduleId: string): Promise<string> {
    if (!this.canaryMode) throw new Error("canary scheduler probe disabled");
    const row = this.ctx.storage.sql
      .exec<ScheduleRow>(
        "SELECT * FROM schedules WHERE schedule_id = ?",
        scheduleId,
      )
      .toArray()[0];
    if (!row || !row.schedule_id.startsWith("canary-g5-"))
      throw new Error("canary schedule not found");
    const job = await this.jobForOccurrence(row, row.next_run_at);
    await this.queueFor(row).sendBatch([
      { body: job },
      { body: { ...job } },
    ]);
    return job.id;
  }

  async fireAlarmForCanary(): Promise<void> {
    if (!this.canaryMode) throw new Error("canary scheduler probe disabled");
    await this.alarm();
  }

  async diagnosticsForCanary(scheduleId: string): Promise<{
    incarnationId: string;
    schedulePresent: boolean;
    nextRunAt: number | null;
    alarmAt: number | null;
  }> {
    if (!this.canaryMode) throw new Error("canary scheduler probe disabled");
    const row = this.ctx.storage.sql
      .exec<{ next_run_at: number }>(
        "SELECT next_run_at FROM schedules WHERE schedule_id = ?",
        scheduleId,
      )
      .toArray()[0];
    return {
      incarnationId: this.incarnationId,
      schedulePresent: Boolean(row),
      nextRunAt: row?.next_run_at ?? null,
      alarmAt: await this.ctx.storage.getAlarm(),
    };
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const due = this.ctx.storage.sql
      .exec<ScheduleRow>(
        `SELECT * FROM schedules
         WHERE next_run_at <= ? ORDER BY next_run_at LIMIT 100`,
        now,
      )
      .toArray();
    for (const row of due) {
      const occurrence = row.next_run_at;
      const job = await this.jobForOccurrence(row, occurrence);
      await this.queueFor(row).send(job);
      const next = nextOccurrence(
        {
          pattern: row.pattern ?? undefined,
          everyMs: row.every_ms ?? undefined,
          timezone: row.timezone ?? undefined,
          endDate: row.end_date ?? undefined,
        },
        occurrence,
      );
      if (next === null)
        this.ctx.storage.sql.exec(
          "DELETE FROM schedules WHERE schedule_id = ?",
          row.schedule_id,
        );
      else
        this.ctx.storage.sql.exec(
          "UPDATE schedules SET next_run_at = ? WHERE schedule_id = ?",
          next,
          row.schedule_id,
        );
    }
    await this.setNextAlarm();
  }
}
