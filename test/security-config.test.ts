import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("security configuration", () => {
  const production = readFileSync(resolve("wrangler.jsonc"), "utf8");
  const canary = readFileSync(resolve("wrangler.canary.jsonc"), "utf8");
  const staging = readFileSync(resolve("wrangler.staging.jsonc"), "utf8");
  const probe = readFileSync(resolve("src/g9-access-probe.ts"), "utf8");
  const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));

  it("requires Access JWT validation on the isolated operations plane", () => {
    expect(canary).toContain('"ACCESS_REQUIRED": "true"');
    expect(canary).toContain(
      '"ACCESS_TEAM_DOMAIN": "https://rikitrader.cloudflareaccess.com"',
    );
    expect(canary).toContain('"ACCESS_AUD":');
  });

  it("rate limits operations separately from public CRM traffic", () => {
    for (const config of [production, canary, staging]) {
      expect(config).toContain('"name": "OPS_RATE_LIMITER"');
      expect(config).toContain('"limit": 60');
      expect(config).toContain('"period": 60');
    }
  });

  it("restricts operations alert email sender and destination", () => {
    for (const config of [production, canary, staging]) {
      expect(config).toContain('"name": "OPS_ALERT_EMAIL"');
      expect(config).toContain(
        '"destination_address": "rikitrader@gmail.com"',
      );
      expect(config).toContain(
        '"allowed_sender_addresses": ["twenty-alerts@sismo911.com"]',
      );
    }
  });

  it("keeps bearer credentials out of plaintext vars", () => {
    for (const config of [production, canary, staging]) {
      expect(config).not.toMatch(
        /"(?:OPS|CANARY|BACKUP|WEBHOOK|INTERNAL_SERVICE)_TOKEN"\s*:/,
      );
    }
  });

  it("constrains the service-auth probe to canary operations routes", () => {
    expect(probe).toContain('url.pathname !== "/probe"');
    expect(probe).toContain("target.origin !== TARGET_ORIGIN");
    expect(probe).toContain('/^\\/_ops\\/job-failures\\/');
    expect(probe).toContain('"cf-access-client-id"');
    expect(probe).toContain('"cf-access-client-secret"');
    expect(production).not.toContain("ACCESS_SERVICE_CLIENT_SECRET");
    expect(canary).not.toContain("ACCESS_SERVICE_CLIENT_SECRET");
  });

  it("keeps production-topology staging Redis-free and resource-isolated", () => {
    expect(staging).toContain('"name": "twenty-crm-enterprise-staging"');
    expect(staging).toContain('"class_name": "TwentyServer"');
    expect(staging).toContain('"class_name": "TwentyWorker"');
    expect(staging).not.toContain('"class_name": "TwentyContainer"');
    expect(staging).toContain('"binding": "HYPERDRIVE"');
    expect(staging).toContain('"REDIS_BACKEND": "cloudflare"');
    expect(staging).not.toContain("REDIS_URL");
    expect(staging).toContain("twenty-ops-enterprise-staging");
    expect(staging).toContain("twenty-storage-enterprise-staging");
    expect(staging).toContain("twenty-jobs-enterprise-staging");
    expect(staging).not.toContain('"database_name": "twenty-ops"');
    expect(staging).not.toContain('"bucket_name": "twenty-storage"');
    expect(staging).not.toContain('"queue": "twenty-jobs"');
  });

  it("cannot bypass enterprise gates through the local production deploy script", () => {
    expect(packageJson.scripts.deploy).toContain("readiness:check");
    expect(packageJson.scripts.deploy).toContain("security:production:check");
  });

  it("ships the starter cost guard in CI", () => {
    expect(packageJson.scripts["cost:starter:check"]).toBe(
      "node scripts/check-starter-cost-config.mjs",
    );
    const workflow = readFileSync(resolve(".github/workflows/deploy.yml"), "utf8");
    expect(workflow).toContain("bun run cost:starter:check");
  });
});
