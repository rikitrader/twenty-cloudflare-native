import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { encryptProviderValue } from '../src/provider-crypto';
import { executeProviderSync } from '../src/provider-sync';
import type { Env } from '../src/types';

const workspace = 'provider-sync-workspace';
const account = 'provider-sync-account';
const now = '2026-09-17T00:00:00.000Z';
let db: DatabaseSync;
let env: Env;

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }
  const prepare = (sql: string) => ({ bind: (...values: unknown[]) => {
    const statement = db.prepare(sql);
    return {
      first: async () => statement.get(...values as never[]) ?? null,
      all: async () => ({ results: statement.all(...values as never[]) }),
      run: async () => ({ success: true, meta: statement.run(...values as never[]) }),
    };
  } });
  env = {
    INTEGRATION_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(11))),
    CRM_DB: { prepare },
  } as unknown as Env;
  db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run(workspace, 'Provider sync', now);
  db.prepare('INSERT INTO integration_accounts VALUES (?,?,?,?,?,?,?,?)')
    .run(account, workspace, 'google', 'Provider Owner', 'connected', '{}', now, now);
  db.prepare('INSERT INTO integration_sync_state (account_id,workspace_id,updated_at) VALUES (?,?,?)')
    .run(account, workspace, now);
});

afterEach(() => {
  vi.unstubAllGlobals();
  db.close();
});

async function storeTokens() {
  const encrypted = await encryptProviderValue(env, {
    access_token: 'real-access-token',
    refresh_token: 'real-refresh-token',
    expires_at: '2099-01-01T00:00:00.000Z',
  }, `integration:${workspace}:${account}:google`);
  db.prepare('INSERT INTO integration_credentials (account_id,workspace_id,provider,encrypted_tokens,token_iv,scopes_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(account, workspace, 'google', encrypted.ciphertext, encrypted.iv, '["calendar","mail"]', now, now);
}

it('synchronizes real provider responses into tenant-scoped folders and calendar records', async () => {
  await storeTokens();
  const providerFetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ labels: [{ id: 'INBOX', name: 'Inbox', type: 'system' }] }))
    .mockResolvedValueOnce(Response.json({ items: [{
      id: 'provider-event-1', summary: 'Provider meeting', description: 'Synced description',
      start: { dateTime: '2026-09-18T14:00:00.000Z' }, end: { dateTime: '2026-09-18T15:00:00.000Z' },
      attendees: [{ email: 'person@example.test', displayName: 'Person' }], status: 'confirmed',
    }] }));
  vi.stubGlobal('fetch', providerFetch);

  const response = await executeProviderSync({ type: 'provider.sync', data: { workspaceId: workspace, accountId: account } }, env);
  expect(response.status).toBe(204);
  expect(providerFetch).toHaveBeenCalledTimes(2);
  expect(providerFetch.mock.calls[0][1].headers.authorization).toBe('Bearer real-access-token');
  expect(db.prepare('SELECT name,folder_type FROM integration_message_folders WHERE account_id=?').get(account))
    .toEqual({ name: 'Inbox', folder_type: 'system' });
  expect(db.prepare('SELECT workspace_id,title,created_by FROM native_calendar_events').get())
    .toEqual({ workspace_id: workspace, title: 'Provider meeting', created_by: `integration:${account}` });
  expect(db.prepare('SELECT last_completed_at,last_error_code FROM integration_sync_state WHERE account_id=?').get(account))
    .toMatchObject({ last_error_code: null });
});

it('records a safe failure code and asks the queue to retry provider failures', async () => {
  await storeTokens();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unavailable', { status: 503 })));
  const response = await executeProviderSync({ type: 'provider.sync', data: { workspaceId: workspace, accountId: account } }, env);
  expect(response.status).toBe(503);
  expect(response.headers.get('x-twenty-execution-outcome')).toBe('not-started');
  expect(db.prepare('SELECT last_error_code FROM integration_sync_state WHERE account_id=?').get(account))
    .toEqual({ last_error_code: 'gmail_http_503' });
});
