import { readFile } from "node:fs/promises";

const manifestUrl = new URL("../docs/enterprise-readiness.json", import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
const expected = Array.from({ length: 14 }, (_, index) => `G${index}`);
const knownStatuses = new Set(["blocked", "partial", "passed"]);
const throughIndex = process.argv.indexOf("--through");
const through =
  throughIndex === -1 ? "G13" : process.argv[throughIndex + 1];
if (!expected.includes(through))
  throw new Error(`invalid --through gate: ${through ?? "missing"}`);
const throughNumber = Number(through.slice(1));

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
const g3Evidence = await evidenceJson("docs/evidence/g3-production-session-cache-soak.json");
const g10Evidence = await evidenceJson("docs/evidence/g10-production-security-inspection.json");
const g12Evidence = await evidenceJson("docs/evidence/g12-rollback-drill.json");
const g13Evidence = await evidenceJson("docs/evidence/g13-production-observation.json");
const evidenceBackstops = [
  ["G3", g3Evidence?.result !== "passed"],
  ["G10", g10Evidence?.result !== "passed"],
  ["G12", g12Evidence?.passed !== true],
  ["G13", g13Evidence?.result === "blocked"],
];
for (const [id, evidenceIsIncomplete] of evidenceBackstops) {
  const gate = manifest.gates.find((item) => item.id === id);
  if (gate?.status === "passed" && evidenceIsIncomplete)
    throw new Error(`${id} cannot be passed while its evidence is incomplete`);
}

const scopedGates = manifest.gates.filter(
  (gate) => Number(gate.id.slice(1)) <= throughNumber,
);
const counts = Object.fromEntries(
  [...knownStatuses].map((status) => [
    status,
    scopedGates.filter((gate) => gate.status === status).length,
  ]),
);
const pending = scopedGates.filter((gate) => gate.status !== "passed");

console.log(
  JSON.stringify(
    {
      objective: manifest.objective,
      through,
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
