import { describe, expect, it } from "vitest";
import { normalizeRedisMonitorTrace } from "../scripts/runtime-contract-lib.mjs";

describe("runtime Redis contract normalization", () => {
  it("retains command families while removing payloads and identifiers", () => {
    const secret = "customer-secret-payload";
    const trace = [
      '1753380000.000001 [0 127.0.0.1:1000] "evalsha" "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" "1" "bull:cron-queue:wait" "job-id" "customer-secret-payload"',
      '1753380000.000002 [0 lua] "ZRANGEBYSCORE" "bull:cron-queue:delayed" "0" "1"',
      '1753380000.000003 [0 127.0.0.1:1001] "bzpopmin" "bull:cron-queue:marker" "5"',
      '1753380000.000004 [0 127.0.0.1:1002] "info"',
    ].join("\n");

    const contract = normalizeRedisMonitorTrace(trace, [
      { name: "health", method: "GET", path: "/healthz", status: 200 },
    ]);

    expect(contract.observations).toEqual({
      bullmqClientCommands: ["bzpopmin", "evalsha"],
      bullmqLuaEffectCommands: ["zrangebyscore"],
      directOrPlatformCommands: ["info"],
      evalshaDigests: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
      queueNames: ["cron-queue"],
    });
    expect(JSON.stringify(contract)).not.toContain(secret);
    expect(JSON.stringify(contract)).not.toContain("job-id");
    expect(JSON.stringify(contract)).not.toContain("1753380000");
  });

  it("rejects a trace with no monitor commands", () => {
    expect(() => normalizeRedisMonitorTrace("OK\n", [])).toThrow(
      "did not contain any parseable commands",
    );
  });
});
