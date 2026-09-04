import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const CONFIG = "wrangler.jsonc";
const APPROVAL = "CUTOVER_APPROVAL_REQUIRED";
const BASE_URL = (
  process.env.PRODUCTION_URL ?? "https://twenty-crm.rikitrader.workers.dev"
).replace(/\/$/, "");
const EVIDENCE_PATH = "docs/evidence/g13-production-cutover.json";

function option(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function command(binary, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function productionVersion() {
  const result = await command("./node_modules/.bin/wrangler", [
    "deployments",
    "status",
    "--config",
    CONFIG,
  ]);
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/)?.[0] ?? null;
}

async function status() {
  const response = await fetch(`${BASE_URL}/_status`, {
    signal: AbortSignal.timeout(30_000),
  });
  return { httpStatus: response.status, body: await response.json().catch(() => ({})) };
}

const dryRun = process.argv.includes("--dry-run");
const startedAt = new Date().toISOString();
const beforeVersion = await productionVersion().catch(() => null);
const beforeStatus = await status().catch((error) => ({ error: String(error) }));

if (!dryRun && process.env.CUTOVER_APPROVAL !== APPROVAL)
  throw new Error(`set CUTOVER_APPROVAL=${APPROVAL} for an authorized cutover`);

// G13 is the observation period that begins after cutover. Requiring it here
// would make cutover impossible, so the production mutation gate is G0-G12.
const readiness = await command("node", [
  "scripts/enterprise-readiness.mjs",
  "--through",
  "G12",
  "--require-ready",
]);
const security = await command("node", ["scripts/check-production-security.mjs"]);
const preflightPassed = readiness.code === 0 && security.code === 0;
const preflight = {
  readinessExitCode: readiness.code,
  securityExitCode: security.code,
  passed: preflightPassed,
};

const evidence = {
  schemaVersion: 1,
  gate: "G13",
  operation: "controlled-production-cutover",
  startedAt,
  productionChanged: false,
  dryRun,
  beforeVersion,
  beforeStatus,
  preflight,
  result: "blocked",
};

if (!preflightPassed) {
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
  process.exitCode = 1;
} else if (dryRun) {
  evidence.result = "ready-to-cutover";
  console.log(JSON.stringify(evidence, null, 2));
} else {
  const deployment = await command("./node_modules/.bin/wrangler", [
    "deploy",
    "--config",
    CONFIG,
    "--message",
    `controlled Redis-free production cutover ${startedAt}`,
  ]);
  if (deployment.code !== 0) {
    await writeFile(EVIDENCE_PATH, `${JSON.stringify({ ...evidence, deploymentExitCode: deployment.code }, null, 2)}\n`);
    throw new Error(deployment.stderr || deployment.stdout);
  }
  const afterVersion = await productionVersion();
  const afterStatus = await status();
  const healthy =
    afterStatus.httpStatus === 200 &&
    afterStatus.body.status === "ok" &&
    afterStatus.body.redisBackend === "cloudflare" &&
    afterStatus.body.productionReady === true &&
    afterStatus.body.durableRedis === true;
  if (!healthy && beforeVersion) {
    await command("./node_modules/.bin/wrangler", [
      "rollback",
      beforeVersion,
      "--config",
      CONFIG,
      "--message",
      "automatic rollback after failed Redis-free cutover health validation",
      "--yes",
    ]);
  }
  const finalEvidence = {
    ...evidence,
    productionChanged: true,
    afterVersion,
    afterStatus,
    healthy,
    result: healthy ? "passed" : "rolled-back",
    completedAt: new Date().toISOString(),
  };
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(finalEvidence, null, 2)}\n`);
  console.log(JSON.stringify(finalEvidence, null, 2));
  if (!healthy) process.exitCode = 1;
}
