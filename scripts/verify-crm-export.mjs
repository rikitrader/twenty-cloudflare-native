#!/usr/bin/env node
/** Read-only integrity checks for the audited PostgreSQL NDJSON export. */
import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const value = (name, fallback = "") => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback;
};
const input = value("input");
const expectedPath = value("expected");
if (!input) throw new Error("--input <ndjson> is required");
const expected = expectedPath ? JSON.parse(readFileSync(expectedPath, "utf8")) : {};
const counts = { contact: 0, company: 0, opportunity: 0 };
const ids = new Map();
const errors = [];
const samples = {};
const records = [];
let line = 0;
const rl = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
for await (const raw of rl) {
  line += 1;
  if (!raw.trim()) continue;
  let item;
  try { item = JSON.parse(raw); } catch { errors.push(`line ${line}: invalid JSON`); continue; }
  if (!item || !/^(contact|company|opportunity)$/.test(item.objectType) || !item.record || typeof item.record !== "object") {
    errors.push(`line ${line}: invalid object envelope`); continue;
  }
  const type = item.objectType; const record = item.record; const id = record.id;
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) errors.push(`line ${line}: invalid ${type} id`);
  const key = `${type}:${id}`;
  if (ids.has(key)) errors.push(`line ${line}: duplicate ${key} (first line ${ids.get(key)})`); else ids.set(key, line);
  counts[type] += 1; if (!samples[type]) samples[type] = record;
  if (record.createdAt && Number.isNaN(Date.parse(record.createdAt))) errors.push(`line ${line}: invalid createdAt`);
  if (record.updatedAt && Number.isNaN(Date.parse(record.updatedAt))) errors.push(`line ${line}: invalid updatedAt`);
  records.push({ type, record, line });
}
for (const { record, line: sourceLine } of records) {
  if (record.companyId && !ids.has(`company:${record.companyId}`)) errors.push(`line ${sourceLine}: missing company ${record.companyId}`);
  if (record.pointOfContactId && !ids.has(`contact:${record.pointOfContactId}`)) errors.push(`line ${sourceLine}: missing contact ${record.pointOfContactId}`);
  if (record.pipelineId && typeof record.pipelineId !== "string") errors.push(`line ${sourceLine}: invalid pipeline reference`);
}
for (const type of Object.keys(counts)) {
  if (expected[type] != null && Number(expected[type]) !== counts[type]) errors.push(`${type}: expected ${expected[type]}, found ${counts[type]}`);
}
const report = { input, counts, uniqueRecords: ids.size, samples, errors, result: errors.length ? "failed" : "passed" };
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
