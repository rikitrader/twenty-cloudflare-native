import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  getContainer: vi.fn(),
}));

import { getContainer } from "@cloudflare/containers";
import {
  evaluateOperationsAlerts,
  runOperationsAlertCheck,
  sendOperationsAlertTest,
} from "../src/operations-alerts";
import type { Env } from "../src/types";

const getContainerMock = vi.mocked(getContainer);

function metrics(oldest?: string): QueueMetrics {
  return {
    backlogCount: oldest ? 1 : 0,
    backlogBytes: oldest ? 100 : 0,
    oldestMessageTimestamp: oldest ? new Date(oldest) : undefined,
  };
}

beforeEach(() => {
  getContainerMock.mockReset();
  getContainerMock.mockReturnValue({
    fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
  } as never);
});

describe("operations alerting", () => {
  it("evaluates executor, job age, and DLQ age independently", () => {
    const alerts = evaluateOperationsAlerts(
      {
        jobs: metrics("2026-07-25T00:00:00.000Z"),
        dlq: metrics("2026-07-24T23:50:00.000Z"),
        executorReady: false,
      },
      new Date("2026-07-25T00:11:00.000Z").getTime(),
    );
    expect(alerts.map(({ code }) => code).sort()).toEqual([
      "dlq-age",
      "executor-not-ready",
      "job-queue-age",
    ]);
  });

  it("sends once for a stable alert fingerprint and persists dedupe state", async () => {
    let state: string | null = null;
    const send = vi.fn().mockResolvedValue({ messageId: "email-1" });
    const env = {
      INTERNAL_SERVICE_TOKEN: "internal",
      OPS_ALERT_EMAIL: { send },
      OPS_ALERT_FROM: "twenty-alerts@sismo911.com",
      OPS_ALERT_TO: "rikitrader@gmail.com",
      JOBS_QUEUE: {
        metrics: vi
          .fn()
          .mockResolvedValue(metrics("2026-07-25T00:00:00.000Z")),
      },
      JOBS_DLQ: { metrics: vi.fn().mockResolvedValue(metrics()) },
      STATUS_KV: {
        get: vi.fn().mockImplementation(async () =>
          state ? JSON.parse(state) : null,
        ),
        put: vi.fn().mockImplementation(async (_key, value) => {
          state = value;
        }),
      },
    } as unknown as Env;
    const now = new Date("2026-07-25T00:06:00.000Z").getTime();

    await runOperationsAlertCheck(env, now);
    await runOperationsAlertCheck(env, now + 60_000);

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "rikitrader@gmail.com",
        subject: "[HIGH] Twenty Cloudflare operations alert",
      }),
    );
    expect(env.STATUS_KV.put).toHaveBeenCalledTimes(2);
  });

  it("sends a clearly labeled synthetic threshold delivery test", async () => {
    const send = vi.fn().mockResolvedValue({ messageId: "email-test" });
    const alerts = await sendOperationsAlertTest(
      {
        OPS_ALERT_EMAIL: { send },
        OPS_ALERT_FROM: "twenty-alerts@sismo911.com",
        OPS_ALERT_TO: "rikitrader@gmail.com",
      } as unknown as Env,
      new Date("2026-07-25T00:11:00.000Z").getTime(),
    );
    expect(alerts.map(({ code }) => code).sort()).toEqual([
      "dlq-age",
      "executor-not-ready",
      "job-queue-age",
    ]);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "[TEST][CRITICAL] Twenty Cloudflare operations alert",
      }),
    );
  });
});
