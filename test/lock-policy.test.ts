import { describe, expect, it } from "vitest";
import { lockClaimDisposition } from "../src/cloudflare-state/lock-policy";

describe("Durable Object lock claim policy", () => {
  it("acquires an unowned lock", () => {
    expect(lockClaimDisposition(undefined, "job-a")).toBe("acquire");
  });

  it("renews a redelivered job claim owned by the same job", () => {
    expect(lockClaimDisposition("job-a", "job-a")).toBe("renew");
  });

  it("rejects a different job owner as a duplicate", () => {
    expect(lockClaimDisposition("job-a", "job-b")).toBe("busy");
  });
});
