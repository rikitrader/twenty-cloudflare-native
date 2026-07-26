import { describe, expect, it } from "vitest";
import {
  nextOccurrence,
  scheduleOccurrenceIdentity,
} from "../src/schedule";

describe("recurring schedule calculation", () => {
  it("calculates interval occurrences from the previous logical occurrence", () => {
    expect(nextOccurrence({ everyMs: 60_000 }, 1_000_000)).toBe(1_060_000);
  });

  it("supports timezone-aware cron patterns", () => {
    const next = nextOccurrence(
      { pattern: "0 9 * * *", timezone: "America/New_York" },
      Date.parse("2026-07-24T12:00:00Z"),
    );
    expect(new Date(next!).toISOString()).toBe("2026-07-24T13:00:00.000Z");
  });

  it("handles the New York spring-forward gap deterministically", () => {
    const next = nextOccurrence(
      { pattern: "30 2 * * *", timezone: "America/New_York" },
      Date.parse("2026-03-07T08:00:00Z"),
    );
    expect(new Date(next!).toISOString()).toBe("2026-03-08T07:30:00.000Z");
  });

  it("does not duplicate a wall-clock occurrence during fall-back", () => {
    const first = nextOccurrence(
      { pattern: "30 1 * * *", timezone: "America/New_York" },
      Date.parse("2026-11-01T04:00:00Z"),
    );
    const afterFirst = nextOccurrence(
      { pattern: "30 1 * * *", timezone: "America/New_York" },
      first!,
    );
    expect(new Date(first!).toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(new Date(afterFirst!).toISOString()).toBe(
      "2026-11-02T06:30:00.000Z",
    );
  });

  it("derives a stable bounded identity for a logical occurrence", async () => {
    const first = await scheduleOccurrenceIdentity("workflow:daily", 1234);
    const duplicate = await scheduleOccurrenceIdentity("workflow:daily", 1234);
    const next = await scheduleOccurrenceIdentity("workflow:daily", 1235);
    expect(first).toEqual(duplicate);
    expect(first).not.toEqual(next);
    expect(first.jobId).toMatch(/^schedule:[a-f0-9]{64}$/);
    expect(first.dedupeKey).toBe("schedule:workflow:daily:1234");
  });

  it("stops after the configured end date", () => {
    expect(
      nextOccurrence(
        { everyMs: 60_000, endDate: 1_030_000 },
        1_000_000,
      ),
    ).toBeNull();
  });

  it("rejects invalid or dangerously tight schedules", () => {
    expect(() => nextOccurrence({ everyMs: 10 }, Date.now())).toThrow(
      "invalid schedule interval",
    );
    expect(() => nextOccurrence({}, Date.now())).toThrow(
      "schedule requires pattern or everyMs",
    );
  });
});
