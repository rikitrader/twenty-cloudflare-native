import { readFile } from "node:fs/promises";

const files = ["wrangler.jsonc", "wrangler.canary.jsonc", "wrangler.staging.jsonc"];

function stripJsonComments(input) {
  let out = "";
  let quoted = false;
  let escaped = false;
  let line = false;
  let block = false;
  for (let i = 0; i < input.length; i += 1) {
    const c = input[i];
    const n = input[i + 1];
    if (line) {
      if (c === "\n") {
        line = false;
        out += c;
      }
      continue;
    }
    if (block) {
      if (c === "*" && n === "/") {
        block = false;
        i += 1;
      }
      continue;
    }
    if (quoted) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      out += c;
    } else if (c === "/" && n === "/") {
      line = true;
      i += 1;
    } else if (c === "/" && n === "*") {
      block = true;
      i += 1;
    } else out += c;
  }
  return out;
}

const errors = [];
const warnings = [];
let productionConfig;
for (const file of files) {
  const config = JSON.parse(stripJsonComments(await readFile(file, "utf8")));
  if (file === "wrangler.jsonc") productionConfig = config;
  const crons = config.triggers?.crons ?? [];
  if (crons.some((cron) => cron === "*/5 * * * *"))
    errors.push(`${file}: five-minute cron keeps starter containers hot`);
  const instances = (config.containers ?? []).reduce(
    (sum, container) => sum + Number(container.max_instances ?? 0),
    0,
  );
  if (file === "wrangler.staging.jsonc" && instances > 3)
    warnings.push(`${file}: ${instances} maximum instances; stop staging outside test windows`);
  if (file === "wrangler.jsonc" && instances !== 3)
    errors.push(
      `${file}: production must define exactly two core containers and one backup`,
    );
}

const productionServer = productionConfig?.containers?.find(
  (container) => container.class_name === "TwentyServer",
);
const productionWorker = productionConfig?.containers?.find(
  (container) => container.class_name === "TwentyWorker",
);
const productionBackup = productionConfig?.containers?.find(
  (container) => container.class_name === "TwentyBackup",
);
if (
  productionConfig?.containers?.some(
    (container) => container.class_name === "TwentyContainer",
  )
)
  errors.push("wrangler.jsonc: legacy all-in-one container must remain retired");
for (const [role, container] of [
  ["server", productionServer],
  ["worker", productionWorker],
]) {
  if (container?.instance_type !== "standard-1")
    errors.push(`wrangler.jsonc: production ${role} must remain standard-1`);
  if (container?.max_instances !== 1)
    errors.push(`wrangler.jsonc: production ${role} must remain capped at one instance`);
}
if (productionBackup?.instance_type !== "basic")
  errors.push("wrangler.jsonc: production backup must remain basic");
if (productionBackup?.max_instances !== 1)
  errors.push("wrangler.jsonc: production backup must remain capped at one instance");

const [containerSource, workerSource, backupSource] = await Promise.all([
  readFile("src/containers.ts", "utf8"),
  readFile("src/index.ts", "utf8"),
  readFile("src/backup.ts", "utf8"),
]);
if (!containerSource.includes('sleepAfter = "20m"'))
  errors.push("src/containers.ts: idle containers must retain the 20-minute sleep policy");
if (
  !workerSource.includes('STATUS_KV.get("last-customer-activity")') ||
  !workerSource.includes("hasRecentCustomerActivity(")
)
  errors.push("src/index.ts: health probes must remain customer-activity-aware");
if (!backupSource.includes('STATUS_KV.get("last-customer-activity")'))
  errors.push("src/backup.ts: idle backups must use customer activity, not cron health writes");

const result = {
  checkedAt: new Date().toISOString(),
  profile: "starter",
  result: errors.length === 0 ? "passed" : "failed",
  errors,
  warnings,
};
console.log(JSON.stringify(result, null, 2));
if (errors.length > 0) process.exitCode = 1;
