import { describe, expect, it } from "vitest";
import {
  cloudflareBackendMisconfigured,
  deploymentMode,
  externalMode,
  redisBackend,
  type Env,
} from "../src/types";

const env = (values: Partial<Env>): Env => values as Env;

describe("deployment mode", () => {
  it("rejects all external database topologies", () => {
    expect(externalMode(env({}))).toBe(false);
  });

  it("labels only the supported D1 topology as cloudflare-d1", () => {
    expect(deploymentMode(env({}))).toBe("misconfigured");
    expect(deploymentMode(env({ CRM_DB: {} as D1Database, D1_NATIVE_MODE: "true" }))).toBe("cloudflare-d1");
  });

  it("keeps Cloudflare as the sole coordination backend", () => {
    expect(redisBackend(env({}))).toBe("cloudflare");
  });

  it("fails closed when Cloudflare mode lacks external topology prerequisites", () => {
    expect(
      cloudflareBackendMisconfigured(env({ REDIS_BACKEND: "cloudflare" })),
    ).toBe(true);
    expect(
      cloudflareBackendMisconfigured(
        env({ REDIS_BACKEND: "cloudflare", CANARY_MODE: "true" }),
      ),
    ).toBe(false);
    expect(
      cloudflareBackendMisconfigured(
        env({
          REDIS_BACKEND: "cloudflare",
          D1_NATIVE_MODE: "true",
          CRM_DB: {} as D1Database,
        }),
      ),
    ).toBe(false);
  });
});
