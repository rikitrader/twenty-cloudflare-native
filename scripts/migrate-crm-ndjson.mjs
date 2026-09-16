#!/usr/bin/env node
/**
 * Resumable PostgreSQL export bridge.
 *
 * The source side is deliberately an NDJSON artifact (one record per line),
 * produced by an audited PostgreSQL exporter. This keeps the tool read-only
 * against the source database and makes dry-runs/replays deterministic.
 * Each line must be { objectType: "contact"|"company"|"opportunity", record }.
 */
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const value = process.argv[i];
  if (value.startsWith("--")) args.set(value.slice(2), process.argv[i + 1]?.startsWith("--") ? true : process.argv[++i] ?? true);
}
const input = String(args.get("input") ?? "");
const endpoint = String(args.get("endpoint") ?? "").replace(/\/$/, "");
const workspaceId = String(args.get("workspace-id") ?? "");
const token = String(args.get("access-token") ?? process.env.CLOUDFLARE_ACCESS_TOKEN ?? "");
const batchSize = Math.min(Math.max(Number(args.get("batch-size") ?? 50), 1), 100);
const statePath = String(args.get("state") ?? `${input}.state.json`);
const dryRun = args.has("dry-run");
if (!input) throw new Error("--input <ndjson> is required");
if (!dryRun && (!endpoint || !workspaceId || !token)) throw new Error("--endpoint, --workspace-id and --access-token are required unless --dry-run is used");

const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { line: 0, processed: 0, failed: 0 };
let line = 0;
let batch = [];
let processed = Number(state.processed) || 0;
let failed = Number(state.failed) || 0;

async function flush() {
  if (!batch.length) return;
  const payload = batch;
  batch = [];
  if (dryRun) {
    processed += payload.length;
    return;
  }
  const runId = String(state.runId ?? `${workspaceId}-${Date.now()}`);
  state.runId = runId;
  const response = await fetch(`${endpoint}/api/crm/import`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-workspace-id": workspaceId, "x-request-id": `migration-${runId}-${line}` },
    body: JSON.stringify({ runId, cursor: String(line), objectType: payload[0].objectType, records: payload.map((item) => item.record), done: false }),
  });
  if (!response.ok) throw new Error(`import batch failed (${response.status}): ${await response.text()}`);
  const result = await response.json();
  state.cursor = result?.data?.cursor ?? String(line);
  processed += payload.length;
}

const rl = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
for await (const raw of rl) {
  line += 1;
  if (line <= Number(state.line || 0)) continue;
  if (!raw.trim()) continue;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { failed += 1; continue; }
  if (!parsed || !/^(contact|company|opportunity)$/.test(parsed.objectType) || !parsed.record || typeof parsed.record !== "object") { failed += 1; continue; }
  if (batch.length && batch[0].objectType !== parsed.objectType) await flush();
  batch.push(parsed);
  if (batch.length >= batchSize) await flush();
  state.line = line;
  state.processed = processed;
  state.failed = failed;
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}
await flush();
if (!dryRun && state.runId) {
  const response = await fetch(`${endpoint}/api/crm/import`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-workspace-id": workspaceId, "x-request-id": `migration-${state.runId}-complete` },
    body: JSON.stringify({ runId: state.runId, cursor: String(line), objectType: "contact", records: [], done: true }),
  });
  if (!response.ok) throw new Error(`import completion failed (${response.status}): ${await response.text()}`);
}
state.line = line; state.processed = processed; state.failed = failed; state.completed = true;
writeFileSync(statePath, JSON.stringify(state, null, 2));
console.log(JSON.stringify({ input, dryRun, line, processed, failed, state: statePath }));
