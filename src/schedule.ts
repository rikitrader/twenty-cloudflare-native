import { CronExpressionParser } from "cron-parser";

const MAX_SCHEDULE_MS = 365 * 24 * 60 * 60_000;

export interface ScheduleInput {
  scheduleId: string;
  queueName: string;
  jobName: string;
  data: unknown;
  retryLimit: number;
  priority: number;
  pattern?: string;
  everyMs?: number;
  timezone?: string;
  startDate?: string | number;
  endDate?: string | number;
}

export async function scheduleOccurrenceIdentity(
  scheduleId: string,
  occurrence: number,
): Promise<{ jobId: string; dedupeKey: string }> {
  const dedupeKey = `schedule:${scheduleId}:${occurrence}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(dedupeKey),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return { jobId: `schedule:${hex}`, dedupeKey };
}

export function dateMs(
  value: string | number | undefined,
): number | undefined {
  if (value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("invalid schedule date");
  return parsed;
}

export function nextOccurrence(
  input: Pick<
    ScheduleInput,
    "pattern" | "everyMs" | "timezone" | "startDate" | "endDate"
  >,
  after: number,
): number | null {
  const endDate = dateMs(input.endDate);
  let next: number;
  if (input.everyMs !== undefined) {
    if (
      !Number.isSafeInteger(input.everyMs) ||
      input.everyMs < 1_000 ||
      input.everyMs > MAX_SCHEDULE_MS
    )
      throw new Error("invalid schedule interval");
    const start = dateMs(input.startDate);
    next = Math.max(after + input.everyMs, start ?? 0);
  } else if (input.pattern) {
    next = CronExpressionParser.parse(input.pattern, {
      currentDate: new Date(after),
      ...(input.timezone ? { tz: input.timezone } : {}),
      ...(input.startDate ? { startDate: input.startDate } : {}),
    })
      .next()
      .getTime();
  } else {
    throw new Error("schedule requires pattern or everyMs");
  }
  return endDate !== undefined && next > endDate ? null : next;
}
