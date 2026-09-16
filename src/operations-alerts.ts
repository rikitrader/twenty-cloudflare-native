import type { Env } from "./types";

const JOB_AGE_THRESHOLD_MS = 5 * 60_000;
const DLQ_AGE_THRESHOLD_MS = 10 * 60_000;
const REPEAT_INTERVAL_MS = 30 * 60_000;
const ALERT_STATE_KEY = "operations-alert-state";

export interface OperationsAlert {
  code: string;
  severity: "high" | "critical";
  message: string;
}

interface AlertState {
  fingerprint: string;
  active: boolean;
  lastSentAt: number;
}

function ageMs(timestamp: Date | undefined, now: number): number {
  return timestamp ? Math.max(0, now - timestamp.getTime()) : 0;
}

export function evaluateOperationsAlerts(
  input: {
    jobs: QueueMetrics;
    dlq: QueueMetrics;
    executorReady: boolean;
  },
  now = Date.now(),
): OperationsAlert[] {
  const alerts: OperationsAlert[] = [];
  const jobAge = ageMs(input.jobs.oldestMessageTimestamp, now);
  const dlqAge = ageMs(input.dlq.oldestMessageTimestamp, now);
  if (!input.executorReady)
    alerts.push({
      code: "executor-not-ready",
      severity: "critical",
      message: "Twenty job executor health endpoint is unavailable.",
    });
  if (jobAge > JOB_AGE_THRESHOLD_MS)
    alerts.push({
      code: "job-queue-age",
      severity: "high",
      message: `Oldest job queue message is ${Math.ceil(jobAge / 60_000)} minutes old.`,
    });
  if (dlqAge > DLQ_AGE_THRESHOLD_MS)
    alerts.push({
      code: "dlq-age",
      severity: "critical",
      message: `Oldest DLQ message is ${Math.ceil(dlqAge / 60_000)} minutes old.`,
    });
  return alerts;
}

async function sendAlertEmail(
  env: Env,
  subject: string,
  lines: string[],
): Promise<void> {
  if (!env.OPS_ALERT_EMAIL || !env.OPS_ALERT_FROM || !env.OPS_ALERT_TO)
    throw new Error("operations alert email binding is not configured");
  await env.OPS_ALERT_EMAIL.send({
    from: env.OPS_ALERT_FROM,
    to: env.OPS_ALERT_TO,
    subject,
    text: `${lines.join("\n")}\n`,
  });
}

export async function sendOperationsAlertTest(
  env: Env,
  now = Date.now(),
): Promise<OperationsAlert[]> {
  const alerts = evaluateOperationsAlerts(
    {
      jobs: {
        backlogCount: 1,
        backlogBytes: 1,
        oldestMessageTimestamp: new Date(now - JOB_AGE_THRESHOLD_MS - 1),
      },
      dlq: {
        backlogCount: 1,
        backlogBytes: 1,
        oldestMessageTimestamp: new Date(now - DLQ_AGE_THRESHOLD_MS - 1),
      },
      executorReady: false,
    },
    now,
  );
  await sendAlertEmail(
    env,
    "[TEST][CRITICAL] Twenty Cloudflare operations alert",
    [
      "This is an isolated canary delivery test.",
      "No production incident is active.",
      ...alerts.map(
        ({ severity, code, message }) =>
          `${severity.toUpperCase()} ${code}: ${message}`,
      ),
      `Sent at: ${new Date(now).toISOString()}`,
    ],
  );
  return alerts;
}

export async function runOperationsAlertCheck(
  env: Env,
  now = Date.now(),
): Promise<{ alerts: OperationsAlert[]; emailSent: boolean }> {
  if (!env.OPS_ALERT_EMAIL) return { alerts: [], emailSent: false };
  const [jobs, dlq] = await Promise.all([
    env.JOBS_QUEUE.metrics(),
    env.JOBS_DLQ.metrics(),
  ]);
  const alerts = evaluateOperationsAlerts(
    { jobs, dlq, executorReady: true },
    now,
  );
  const fingerprint = alerts
    .map(({ code }) => code)
    .sort()
    .join(",");
  const previous = await env.STATUS_KV.get<AlertState>(
    ALERT_STATE_KEY,
    "json",
  );
  const shouldSendActive =
    alerts.length > 0 &&
    (previous?.fingerprint !== fingerprint ||
      !previous.active ||
      now - previous.lastSentAt >= REPEAT_INTERVAL_MS);
  const shouldSendRecovery =
    alerts.length === 0 && previous?.active === true;
  if (shouldSendActive)
    await sendAlertEmail(
      env,
      `[${alerts.some(({ severity }) => severity === "critical") ? "CRITICAL" : "HIGH"}] Twenty Cloudflare operations alert`,
      alerts.map(({ severity, code, message }) =>
        `${severity.toUpperCase()} ${code}: ${message}`,
      ),
    );
  if (shouldSendRecovery)
    await sendAlertEmail(env, "[RECOVERED] Twenty Cloudflare operations", [
      "Queue age and executor readiness have returned to normal.",
      `Recovered at: ${new Date(now).toISOString()}`,
    ]);
  await env.STATUS_KV.put(
    ALERT_STATE_KEY,
    JSON.stringify({
      fingerprint,
      active: alerts.length > 0,
      lastSentAt:
        shouldSendActive || shouldSendRecovery
          ? now
          : (previous?.lastSentAt ?? 0),
    } satisfies AlertState),
  );
  return {
    alerts,
    emailSent: shouldSendActive || shouldSendRecovery,
  };
}
