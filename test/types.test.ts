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
  it("requires Neon, the fixed Cloudflare backend, and internal service auth", () => {
    expect(externalMode(env({ PG_DATABASE_URL: "postgres://db" }))).toBe(false);
    expect(
      externalMode(
        env({
          PG_DATABASE_URL: "postgres://db",
          REDIS_BACKEND: "cloudflare",
          INTERNAL_SERVICE_TOKEN: "internal-token",
        }),
      ),
    ).toBe(true);
  });

  it("labels only the supported production topology as external-db", () => {
    expect(deploymentMode(env({}))).toBe("misconfigured");
    expect(deploymentMode(env({ PG_DATABASE_URL: "postgres://db" }))).toBe(
      "misconfigured",
    );
    expect(
      deploymentMode(
        env({
          PG_DATABASE_URL: "postgres://db",
          REDIS_BACKEND: "cloudflare",
          INTERNAL_SERVICE_TOKEN: "internal-token",
        }),
      ),
    ).toBe("external-db");
  });

  it("requires an internal token before Cloudflare mode can activate", () => {
    const cloudflare = env({
      PG_DATABASE_URL: "postgres://db",
      REDIS_BACKEND: "cloudflare",
    });
    expect(redisBackend(cloudflare)).toBe("cloudflare");
    expect(redisBackend(env({}))).toBe("cloudflare");
    expect(externalMode(cloudflare)).toBe(false);
    expect(
      externalMode(
        env({
          ...cloudflare,
          INTERNAL_SERVICE_TOKEN: "internal-token",
        }),
      ),
    ).toBe(true);
  });

  it("does not pass Worker-scoped Hyperdrive endpoints into Containers", () => {
    const hyperdriveOnly = env({
      HYPERDRIVE: {
        connectionString: "postgres://hyperdrive/staging",
      } as Hyperdrive,
      REDIS_BACKEND: "cloudflare",
      INTERNAL_SERVICE_TOKEN: "internal-token",
    });
    expect(externalMode(hyperdriveOnly)).toBe(false);
    expect(deploymentMode(hyperdriveOnly)).toBe("misconfigured");
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
          PG_DATABASE_URL: "postgres://example",
          INTERNAL_SERVICE_TOKEN: "secret",
        }),
      ),
    ).toBe(false);
  });
});
