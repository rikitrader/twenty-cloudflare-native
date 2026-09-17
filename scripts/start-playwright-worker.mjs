#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const state = mkdtempSync(join(tmpdir(), 'twenty-cf-playwright-'));
const wrangler = './node_modules/.bin/wrangler';
const common = ['--config', 'wrangler.jsonc', '--local', '--persist-to', state];

function run(args) {
  const result = spawnSync(wrangler, args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${wrangler} ${args.join(' ')} failed`);
}

let child;
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (child && child.exitCode === null) child.kill('SIGTERM');
  rmSync(state, { recursive: true, force: true });
}

try {
  run(['d1', 'migrations', 'apply', 'CRM_DB', ...common]);
  run(['d1', 'migrations', 'apply', 'OPS_DB', ...common]);
  child = spawn(wrangler, ['dev', ...common, '--ip', '127.0.0.1', '--port', '8788'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      INTERNAL_SERVICE_TOKEN: 'playwright-local-only-token',
      WEBHOOK_TOKEN: 'playwright-local-only-webhook-token',
      OUTBOUND_WEBHOOK_SECRET: 'playwright-local-only-outbound-secret',
    },
  });
  child.once('exit', (code, signal) => {
    cleanup();
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { cleanup(); process.exit(0); });
} catch (error) {
  cleanup();
  throw error;
}
