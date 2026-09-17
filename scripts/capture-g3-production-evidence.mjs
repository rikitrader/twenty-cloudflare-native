#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';

const endpoint = process.env.G3_STATUS_URL ?? 'https://twenty-crm.observatorio-publico.workers.dev/_status/g3';
const response = await fetch(endpoint, { headers: { accept: 'application/json' } });
if (!response.ok) throw new Error(`G3 status returned HTTP ${response.status}`);
const status = await response.json();
if (status.gate !== 'G3') throw new Error('unexpected G3 status response');
const evidence = {
  gate: 'G3',
  result: status.ready === true ? 'passed' : 'collecting',
  capturedAt: new Date().toISOString(),
  endpoint,
  requirements: {
    durationMs: status.requiredDurationMs,
    samples: status.requiredSamples,
    maxAllowedGapMs: status.maxAllowedGapMs ?? 1_800_000,
    maxAllowedStateGatewayMs: status.maxAllowedStateGatewayMs ?? 5_000,
  },
  observation: status,
  note: status.ready === true
    ? 'The production collector reports a complete clean seven-day window.'
    : 'Evidence collection is active. This gate cannot pass until real elapsed time and all required samples are present.',
};
await writeFile(new URL('../docs/evidence/g3-production-session-cache-soak.json', import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
