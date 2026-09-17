import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it.each(['new', 'existing', 'submit-new', 'submit-existing', 'saved-session', 'submit-short'])('the compiled UI completes the %s auth scenario', mode => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('./compiled-login-harness.mjs', import.meta.url)), mode], { encoding:'utf8', timeout:25_000 });
  expect(output).toContain('PASS');
}, 30_000);

it('the shipped CRM controls navigate, create, edit, sort and filter against persisted SQLite data', () => {
  const output=execFileSync(process.execPath,[fileURLToPath(new URL('./compiled-login-harness.mjs',import.meta.url)),'crm'],{encoding:'utf8',timeout:45_000});
  expect(output).toContain('PASS compiled CRM navigation');
},50_000);
