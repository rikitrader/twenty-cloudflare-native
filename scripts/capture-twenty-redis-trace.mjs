import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import {
  CAPTURE_IMAGE,
  normalizeRedisMonitorTrace,
} from "./runtime-contract-lib.mjs";

const MAX_TRACE_BYTES = 16 * 1024 * 1024;
const execFileAsync = promisify(execFile);

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

function positiveInteger(name, fallback) {
  const value = Number(option(name, fallback));
  if (!Number.isSafeInteger(value) || value < 5 || value > 300) {
    throw new Error(`${name} must be an integer from 5 through 300`);
  }
  return value;
}

const container = option("--container", "twenty-contract-trace");
const baseUrl = new URL(option("--base-url", "http://127.0.0.1:22020"));
const durationSeconds = positiveInteger("--duration", 70);
const output = resolve(
  option("--output", "docs/twenty-v2.24.1-runtime-contract.json"),
);

if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container)) {
  throw new Error("container must be an explicit Docker container name");
}
if (
  baseUrl.protocol !== "http:" ||
  !["127.0.0.1", "localhost"].includes(baseUrl.hostname)
) {
  throw new Error("base-url must be an isolated local HTTP endpoint");
}

const inspected = await execFileAsync("docker", [
  "inspect",
  "--format",
  "{{.Config.Image}}",
  container,
]);
if (inspected.stdout.trim() !== CAPTURE_IMAGE) {
  throw new Error(
    `refusing to capture unexpected image: ${inspected.stdout.trim()}`,
  );
}

async function requestScenario(name, method, path, body) {
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  await response.arrayBuffer();
  return { name, method, path, status: response.status };
}

async function waitForMonitor(child) {
  return await new Promise((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(new Error("redis-cli MONITOR did not become ready")),
      10_000,
    );

    const onData = (chunk) => {
      if (!chunk.toString().includes("OK")) return;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      resolveReady();
    };

    child.stdout.on("data", onData);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`redis-cli MONITOR exited before ready (${code})`));
    });
  });
}

const monitor = spawn(
  "docker",
  [
    "exec",
    container,
    "timeout",
    String(durationSeconds),
    "redis-cli",
    "MONITOR",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);

let trace = "";
let stderr = "";
let exceededLimit = false;
monitor.stdout.on("data", (chunk) => {
  if (exceededLimit) return;
  trace += chunk.toString();
  if (Buffer.byteLength(trace) > MAX_TRACE_BYTES) {
    exceededLimit = true;
    monitor.kill("SIGTERM");
  }
});
monitor.stderr.on("data", (chunk) => {
  stderr = (stderr + chunk.toString()).slice(-4_096);
});

await waitForMonitor(monitor);

const scenarios = [];
scenarios.push(await requestScenario("root", "GET", "/"));
scenarios.push(await requestScenario("health", "GET", "/healthz"));
scenarios.push(
  await requestScenario("anonymous-graphql", "POST", "/graphql", {
    query: "query RuntimeContractProbe { __typename }",
  }),
);

const exitCode = await new Promise((resolveExit, reject) => {
  monitor.once("error", reject);
  monitor.once("exit", resolveExit);
});

if (exceededLimit) {
  throw new Error(`Redis MONITOR trace exceeded ${MAX_TRACE_BYTES} bytes`);
}
// GNU timeout exits 124 when it handles the timeout itself. Docker exec can
// instead surface the SIGTERM exit status from redis-cli as 143.
if (exitCode !== 0 && exitCode !== 124 && exitCode !== 143) {
  throw new Error(
    `redis-cli MONITOR failed with exit code ${exitCode}: ${stderr.trim()}`,
  );
}

const contract = normalizeRedisMonitorTrace(trace, scenarios);
await writeFile(output, `${JSON.stringify(contract, null, 2)}\n`, "utf8");

console.log(
  `Runtime contract captured: ${contract.observations.queueNames.length} queues, ` +
    `${contract.observations.evalshaDigests.length} Lua digests, ` +
    `${contract.scenarios.length} HTTP scenarios.`,
);
