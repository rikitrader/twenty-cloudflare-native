import { mkdir, writeFile } from 'node:fs/promises';

const origin = (process.env.PRODUCTION_ORIGIN ?? 'https://crm.mipolitico.com').replace(/\/$/, '');
const output = process.env.EVIDENCE_OUTPUT ?? `artifacts/continuity-${new Date().toISOString().replaceAll(':', '-')}.json`;

async function read(path) {
  const response = await fetch(`${origin}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  return response.json();
}

const [health, status, continuity, g3] = await Promise.all([
  read('/healthz'),
  read('/_status'),
  read('/_status/continuity'),
  read('/_status/g3'),
]);
const evidence = { capturedAt: new Date().toISOString(), origin, health, status, continuity, g3 };
await mkdir(new URL(`../${output.split('/').slice(0, -1).join('/') || '.'}/`, import.meta.url), { recursive: true });
await writeFile(new URL(`../${output}`, import.meta.url), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ output, productionReady: status.productionReady, continuityReady: continuity.ready, g3Ready: g3.ready }));
