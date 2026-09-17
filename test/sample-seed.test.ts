import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
// @ts-expect-error Script is shared with the production operator CLI.
import { sampleRows, seedSql } from '../scripts/seed-crm-sample.mjs';

const workspace='75c22091-10d6-4791-bd04-43ffd8ef0926';
const owner='user:11111111-1111-4111-8111-111111111111';
function setup() {
  const db=new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for(const name of readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
  db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run(workspace,'Test','2026-09-17');
  db.prepare("INSERT INTO workspace_members VALUES (?,?,'owner','active',?)").run(workspace,owner,'2026-09-17');
  return db;
}
it('seeds 19 linked fictional records and is repeat-safe without replacing edits',()=>{
  const db=setup();
  try {
    db.exec(seedSql(workspace,owner));
    const rows=sampleRows(workspace,owner);
    for(const [table,records] of Object.entries(rows) as [string,any[]][]) expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toMatchObject({count:records.length});
    db.prepare('UPDATE companies SET name=? WHERE id=?').run('User changed this demo',rows.companies[0].id);
    db.exec(seedSql(workspace,owner));
    expect(db.prepare('SELECT name FROM companies WHERE id=?').get(rows.companies[0].id)).toMatchObject({name:'User changed this demo'});
    expect(db.prepare('SELECT COUNT(*) AS count FROM activities a JOIN contacts p ON a.contact_id=p.id AND a.workspace_id=p.workspace_id JOIN opportunities o ON a.opportunity_id=o.id AND a.workspace_id=o.workspace_id').get()).toMatchObject({count:6});
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {db.close();}
});
it('does not seed a suspended or non-owner workspace',()=>{
  const db=setup();
  try {
    db.prepare("UPDATE workspace_members SET role='member'").run();
    db.exec(seedSql(workspace,owner));
    expect(db.prepare('SELECT COUNT(*) AS count FROM contacts').get()).toMatchObject({count:0});
    db.prepare("UPDATE workspace_members SET role='owner',status='suspended'").run();
    db.exec(seedSql(workspace,owner));
    expect(db.prepare('SELECT COUNT(*) AS count FROM contacts').get()).toMatchObject({count:0});
  } finally {db.close();}
});
it('rejects missing or injected target identifiers',()=>{
  expect(()=>seedSql("'; DROP TABLE contacts; --",owner)).toThrow();
  expect(()=>seedSql(workspace,'unknown')).toThrow();
});
it('rechecks relationship ownership during inserts even if a conflicting ID appeared after preflight',()=>{
  const db=setup();
  try {
    const other='11111111-2222-4333-8444-555555555555';
    const rows=sampleRows(workspace,owner);
    db.prepare('INSERT INTO workspaces VALUES (?,?,?)').run(other,'Other','2026-09-17');
    db.prepare('INSERT INTO companies (id,workspace_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(rows.companies[0].id,other,'Unrelated company','2026-09-17','2026-09-17');
    db.exec(seedSql(workspace,owner));
    expect(db.prepare('SELECT COUNT(*) AS count FROM opportunities WHERE company_id=?').get(rows.companies[0].id)).toMatchObject({count:0});
    expect(db.prepare('SELECT COUNT(*) AS count FROM activities WHERE company_id=?').get(rows.companies[0].id)).toMatchObject({count:0});
    expect(db.prepare('SELECT name FROM companies WHERE id=?').get(rows.companies[0].id)).toMatchObject({name:'Unrelated company'});
  } finally {db.close();}
});
