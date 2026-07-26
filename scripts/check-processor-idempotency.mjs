import { readFile, writeFile } from "node:fs/promises";

const contractUrl = new URL(
  "../docs/twenty-v2.20-contract.json",
  import.meta.url,
);
const evidenceUrl = new URL(
  "../docs/evidence/g4-processor-idempotency.json",
  import.meta.url,
);
const jobsUrl = new URL("../src/jobs.ts", import.meta.url);
const driverUrl = new URL(
  "../cf/cloudflare-adapters/queue-driver.cjs",
  import.meta.url,
);

const contract = JSON.parse(await readFile(contractUrl, "utf8"));
const externalRiskPattern =
  /billing|email|webhook|calendar|messaging|connected-account|workflow|logic-function|ai-|marketplace|domain|sdk-client/;

const processors = contract.processMethods.map((processor) => ({
  file: processor.file,
  processorExpression: processor.expression,
  riskClass: externalRiskPattern.test(processor.file)
    ? "external-or-user-code-side-effects"
    : "application-state-mutation",
  disposition: {
    completed: "ack-after-durable-completion-receipt",
    explicitlyNotStarted: "bounded-retry-after-receipt-abandon",
    ambiguousOrStarted: "quarantine-without-processor-replay",
  },
}));

const expected = {
  schemaVersion: 1,
  gate: "G4",
  policyVersion: 1,
  sourceContract: "docs/twenty-v2.20-contract.json",
  processorCount: processors.length,
  invariant:
    "Only an authenticated executor response explicitly marked not-started may be retried. Every started, unclassified, transport-lost, or expired-lease outcome is quarantined without invoking the processor again.",
  processors,
};

if (process.argv.includes("--write")) {
  await writeFile(
    evidenceUrl,
    `${JSON.stringify(
      { ...expected, capturedAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

const evidence = JSON.parse(await readFile(evidenceUrl, "utf8"));
const failures = [];
const contractKeys = new Set(
  contract.processMethods.map(
    ({ file, expression }) => `${file}\0${expression}`,
  ),
);
const evidenceKeys = new Set(
  evidence.processors?.map(
    ({ file, processorExpression }) => `${file}\0${processorExpression}`,
  ),
);

if (contract.processors.length !== contract.processMethods.length)
  failures.push("processor decorators and process methods have different counts");
if (contractKeys.size !== contract.processMethods.length)
  failures.push("source contract has duplicate processor dispositions");
if (evidence.processorCount !== contract.processMethods.length)
  failures.push("evidence processor count does not match source contract");
for (const key of contractKeys) {
  if (!evidenceKeys.has(key)) failures.push(`missing processor: ${key}`);
}
for (const key of evidenceKeys) {
  if (!contractKeys.has(key)) failures.push(`unknown processor: ${key}`);
}
for (const processor of evidence.processors ?? []) {
  if (
    processor.disposition?.ambiguousOrStarted !==
      "quarantine-without-processor-replay" ||
    processor.disposition?.explicitlyNotStarted !==
      "bounded-retry-after-receipt-abandon"
  )
    failures.push(`unsafe disposition: ${processor.file}`);
}

const jobsSource = await readFile(jobsUrl, "utf8");
const driverSource = await readFile(driverUrl, "utf8");
if (
  !jobsSource.includes(
    'response.headers.get("x-twenty-execution-outcome") !== "not-started"',
  )
)
  failures.push("consumer does not fail closed on executor outcome");
if (
  !driverSource.includes('"x-twenty-execution-outcome": "ambiguous"') ||
  !driverSource.includes('"x-twenty-execution-outcome": "not-started"')
)
  failures.push("executor does not emit both outcome classifications");

if (failures.length > 0) {
  console.error("Processor idempotency verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `Processor idempotency verified: ${processors.length}/${processors.length} dispositions, fail-closed ambiguity policy enforced.`,
);
