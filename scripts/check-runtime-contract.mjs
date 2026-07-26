import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CAPTURE_IMAGE,
  TARGET_IMAGE,
  UNEXERCISED_SCENARIOS,
} from "./runtime-contract-lib.mjs";

const contractPath = resolve(
  process.argv[2] ?? "docs/twenty-v2.20-runtime-contract.json",
);
const contract = JSON.parse(await readFile(contractPath, "utf8"));
const failures = [];

function requireValue(condition, message) {
  if (!condition) failures.push(message);
}

function includes(array, value) {
  return Array.isArray(array) && array.includes(value);
}

requireValue(contract.schemaVersion === 1, "schemaVersion must be 1");
requireValue(
  contract.targetImage === TARGET_IMAGE,
  "target production image digest changed",
);
requireValue(
  contract.captureImage === CAPTURE_IMAGE,
  "runtime capture image digest changed",
);
requireValue(
  contract.captureProfile === "boot-and-anonymous-http-v1",
  "unexpected capture profile",
);
requireValue(
  contract.privacy?.rawTracePersisted === false,
  "raw Redis trace must never be persisted",
);
requireValue(
  contract.coverage?.status === "partial",
  "baseline must not claim complete runtime coverage",
);

for (const scenario of ["root", "health", "anonymous-graphql"]) {
  const observed = contract.scenarios?.find((item) => item.name === scenario);
  requireValue(observed?.status === 200, `${scenario} must return HTTP 200`);
}

requireValue(
  includes(contract.observations?.bullmqClientCommands, "evalsha"),
  "BullMQ EVALSHA was not observed",
);
requireValue(
  includes(contract.observations?.bullmqClientCommands, "bzpopmin"),
  "BullMQ blocking delayed-job poll was not observed",
);
requireValue(
  includes(contract.observations?.queueNames, "cron-queue"),
  "cron-queue activity was not observed",
);
requireValue(
  contract.observations?.evalshaDigests?.length > 0,
  "no BullMQ Lua digests were captured",
);

for (const scenario of UNEXERCISED_SCENARIOS) {
  requireValue(
    includes(contract.coverage?.unexercisedScenarios, scenario),
    `missing explicit coverage gap: ${scenario}`,
  );
}

const serialized = JSON.stringify(contract).toLowerCase();
for (const forbidden of [
  "authorization",
  "set-cookie",
  "access_token",
  "refresh_token",
]) {
  requireValue(!serialized.includes(forbidden), `forbidden trace field: ${forbidden}`);
}

if (failures.length > 0) {
  console.error("Runtime contract verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Runtime contract verified: ${contract.observations.queueNames.length} queues, ` +
    `${contract.observations.evalshaDigests.length} Lua digests, coverage intentionally partial.`,
);
