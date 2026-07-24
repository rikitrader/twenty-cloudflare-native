import { describe, expect, it } from "vitest";
import { deploymentMode, externalMode, type Env } from "../src/types";

const env = (values: Partial<Env>): Env => values as Env;

describe("deployment mode", () => {
  it("requires both durable PostgreSQL and Redis for external mode", () => {
    expect(externalMode(env({ PG_DATABASE_URL: "postgres://db" }))).toBe(false);
    expect(
      externalMode(
        env({
          PG_DATABASE_URL: "postgres://db",
          REDIS_URL: "rediss://redis",
        }),
      ),
    ).toBe(true);
  });

  it("labels all-in-one, hybrid, and production service modes", () => {
    expect(deploymentMode(env({}))).toBe("all-in-one");
    expect(deploymentMode(env({ PG_DATABASE_URL: "postgres://db" }))).toBe(
      "hybrid-neon",
    );
    expect(
      deploymentMode(
        env({
          PG_DATABASE_URL: "postgres://db",
          REDIS_URL: "rediss://redis",
        }),
      ),
    ).toBe("external-db");
  });
});
