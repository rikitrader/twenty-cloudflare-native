import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const BASE_URL =
  process.env.CANARY_BASE_URL ??
  "https://twenty-crm-redis-free-canary.rikitrader.workers.dev";
const POLL_INTERVAL_MS = 2_000;
const TIMEOUT_MS = 4 * 60_000;

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const tokenFile = option("--token-file");
const token = tokenFile
  ? readFileSync(tokenFile, "utf8").trim()
  : process.env.CANARY_TOKEN;
if (!token) throw new Error("set CANARY_TOKEN or pass --token-file");

async function request(path, init = {}) {
  const response = await fetch(new URL(path, BASE_URL), {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const runId = randomUUID();
const startedAt = new Date().toISOString();
const prepared = await request("/_canary/schedule/prepare", {
  method: "POST",
  body: JSON.stringify({ runId }),
});
if (!prepared.response.ok || prepared.body.passed !== true)
  throw new Error(
    `scheduler preparation failed (${prepared.response.status}): ${JSON.stringify(prepared.body)}`,
  );

const deadline = Date.now() + TIMEOUT_MS;
let verified;
while (Date.now() < deadline) {
  verified = await request(
    `/_canary/schedule/verify?jobId=${encodeURIComponent(prepared.body.jobId)}&scheduleId=${encodeURIComponent(prepared.body.scheduleId)}`,
  );
  if (verified.response.status === 200) break;
  if (verified.response.status !== 202)
    throw new Error(
      `scheduler verification failed (${verified.response.status}): ${JSON.stringify(verified.body)}`,
    );
  await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
}
if (!verified?.response.ok || verified.body.passed !== true)
  throw new Error(
    `scheduler occurrence did not settle before timeout: ${JSON.stringify(verified?.body)}`,
  );

console.log(
  JSON.stringify(
    {
      worker: new URL(BASE_URL).hostname,
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      passed: true,
      missedAlarm: prepared.body.missedAlarm,
      duplicateMessagesInjected: prepared.body.duplicateMessagesInjected,
      duplicateAlarmInvocations: prepared.body.duplicateAlarmInvocations,
      calendar: prepared.body.calendar,
      deterministicJobId: prepared.body.jobId,
      execution: {
        status: verified.body.status,
        attempts: verified.body.attempts,
      },
      scheduleRemoved: !verified.body.diagnostics?.schedulePresent,
    },
    null,
    2,
  ),
);
