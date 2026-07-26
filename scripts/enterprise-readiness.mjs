import { readFile } from "node:fs/promises";

const manifestUrl = new URL("../docs/enterprise-readiness.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const expected = Array.from({ length: 14 }, (_, index) => `G${index}`);
const knownStatuses = new Set(["blocked", "partial", "passed"]);

async function evidenceJson(relativePath) {
  try {
    return JSON.parse(
      await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"),
    );
  } catch {
    return null;
  }
}

if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.gates)) {
  throw new Error("invalid enterprise readiness manifest");
}

const ids = manifest.gates.map((gate) => gate.id);
for (const id of expected) {
  if (!ids.includes(id)) throw new Error(`missing enterprise gate ${id}`);
}
for (const gate of manifest.gates) {
  if (!knownStatuses.has(gate.status))
    throw new Error(`invalid status for ${gate.id}: ${gate.status}`);
  if (!Array.isArray(gate.evidence))
    throw new Error(`invalid evidence list for ${gate.id}`);
}

// These gates have machine-readable external acceptance criteria. Keep the
// manifest from becoming an unsafe hand-edited assertion when the evidence is
// still partial or blocked.
const g3Evidence = await evidenceJson("docs/evidence/g3-auth-revocation-canary.json");
const g10Evidence = await evidenceJson("docs/evidence/g10-canary-security.json");
const g13Evidence = await evidenceJson("docs/evidence/g13-production-observation.json");
const evidenceBackstops = [
  ["G3", g3Evidence?.result === "partial"],
  ["G10", g10Evidence?.result === "partial"],
  ["G13", g13Evidence?.result === "blocked"],
];
for (const [id, evidenceIsIncomplete] of evidenceBackstops) {
  const gate = manifest.gates.find((item) => item.id === id);
  if (gate?.status === "passed" && evidenceIsIncomplete)
    throw new Error(`${id} cannot be passed while its evidence is incomplete`);
}

const counts = Object.fromEntries(
  [...knownStatuses].map((status) => [
    status,
    manifest.gates.filter((gate) => gate.status === status).length,
  ]),
);
const pending = manifest.gates.filter((gate) => gate.status !== "passed");

console.log(
  JSON.stringify(
    {
      objective: manifest.objective,
      ready: pending.length === 0,
      counts,
      pending: pending.map(({ id, name, status }) => ({ id, name, status })),
    },
    null,
    2,
  ),
);

if (process.argv.includes("--require-ready") && pending.length > 0) {
  process.exitCode = 1;
}
