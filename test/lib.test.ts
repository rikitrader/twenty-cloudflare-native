import { describe, expect, it } from "vitest";
import {
  backupKey,
  pickLatest,
  shouldSkipBackup,
  bearerAuthorized,
  parseWebhookEvent,
} from "../src/lib";

describe("backupKey", () => {
  it("produces sortable timestamped keys", () => {
    const key = backupKey(new Date("2026-07-10T22:05:13.123Z"));
    expect(key).toBe("backups/2026-07-10T2205.sql");
    const later = backupKey(new Date("2026-07-10T23:00:00.000Z"));
    expect(later > key).toBe(true);
  });
});

describe("pickLatest", () => {
  it("returns the newest key and null for empty", () => {
    expect(
      pickLatest([
        "backups/2026-07-10T2205.sql",
        "backups/2026-07-11T0100.sql",
        "backups/2026-07-09T2300.sql",
      ]),
    ).toBe("backups/2026-07-11T0100.sql");
    expect(pickLatest([])).toBeNull();
  });
});

describe("shouldSkipBackup", () => {
  it("skips when idle since last backup or when no activity ever", () => {
    expect(shouldSkipBackup(null, null)).toBe(true);
    expect(
      shouldSkipBackup("2026-07-10T10:00:00Z", "2026-07-10T11:00:00Z"),
    ).toBe(true);
  });
  it("runs when there is activity newer than the last backup", () => {
    expect(shouldSkipBackup("2026-07-10T12:00:00Z", null)).toBe(false);
    expect(
      shouldSkipBackup("2026-07-10T12:00:00Z", "2026-07-10T11:00:00Z"),
    ).toBe(false);
  });
});

describe("bearerAuthorized", () => {
  it("accepts only the exact configured bearer token", () => {
    expect(bearerAuthorized("Bearer s3cret", "s3cret")).toBe(true);
    expect(bearerAuthorized("Bearer wrong", "s3cret")).toBe(false);
  });
  it("rejects when no token is configured or header missing", () => {
    expect(bearerAuthorized("Bearer anything", undefined)).toBe(false);
    expect(bearerAuthorized(null, "s3cret")).toBe(false);
  });
});

describe("parseWebhookEvent", () => {
  it("extracts eventName from valid Twenty payloads", () => {
    const raw = JSON.stringify({ eventName: "company.created", record: { id: 1 } });
    expect(parseWebhookEvent(raw)).toEqual({ type: "company.created", payload: raw });
  });
  it("rejects malformed, empty, and oversized payloads", () => {
    expect(parseWebhookEvent("not-json{")).toBeNull();
    expect(parseWebhookEvent("")).toBeNull();
    expect(parseWebhookEvent(`{"a":"${"x".repeat(100_001)}"}`)).toBeNull();
  });
});
