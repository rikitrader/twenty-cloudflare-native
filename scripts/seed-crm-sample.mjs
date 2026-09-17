import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SEED_KEY = 'twenty-demo-2026-09-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const quote = value => value === null ? 'NULL' : `'${String(value).replaceAll("'", "''")}'`;
export function seedId(workspaceId, key) {
  const bytes = createHash('sha256').update(`${SEED_KEY}:${workspaceId}:${key}`).digest().subarray(0,16);
  bytes[6] = (bytes[6] & 15) | 128; bytes[8] = (bytes[8] & 63) | 128;
  const hex=bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

/** Fictional, visibly labeled data. Never contains deliverable email addresses. */
export function sampleRows(workspaceId, ownerSubject, now='2026-09-17T12:00:00.000Z') {
  if(!UUID.test(workspaceId) || !/^user:[0-9a-f-]{36}$/i.test(ownerSubject)) throw new Error('Explicit native workspace and owner IDs required');
  const id=key=>seedId(workspaceId,key);
  const common=key=>({id:id(key),workspace_id:workspaceId,created_at:now,updated_at:now,owner_subject:ownerSubject});
  const companies=['Aurora Labs','Cedar Studio','Harbor Partners'].map((name,i)=>({...common(`company-${i}`),name:`DEMO · ${name}`,domain:`demo-${i}.example.invalid`}));
  const contacts=[['Alex','Rivera'],['Sam','Chen'],['Jordan','Morgan'],['Taylor','Patel'],['Casey','Ortiz']].map(([first,last],i)=>({...common(`person-${i}`),first_name:`DEMO ${first}`,last_name:last,email:`demo-${i}@example.invalid`}));
  const pipeline={id:id('pipeline'),workspace_id:workspaceId,name:'DEMO · Sales pipeline',created_at:now};
  const opportunities=['Discovery project','Annual partnership','Service proposal','Completed pilot'].map((name,i)=>({...common(`opportunity-${i}`),name:`DEMO · ${name}`,amount_cents:[125000,480000,275000,90000][i],stage:['prospecting','qualification','proposal','won'][i],company_id:companies[i%3].id,point_of_contact_id:contacts[i].id,pipeline_id:pipeline.id}));
  const activities=['Read this sample note','Plan discovery call','Review proposal','Follow up with partner','Completed sample task','Log sample call'].map((title,i)=>({...common(`activity-${i}`),title:`DEMO · ${title}`,type:['note','task','task','task','task','call'][i],body:'Fictional sample record. Safe to edit; no email or external automation has been sent.',company_id:companies[i%3].id,contact_id:contacts[i%5].id,opportunity_id:opportunities[i%4].id,due_at:i===0?null:'2026-09-24T15:00:00.000Z',completed_at:i===4?now:null}));
  return {companies,contacts,pipelines:[pipeline],opportunities,activities};
}

/** Every insert rechecks owner membership. Conflict is a no-op, never overwrite. */
export function seedSql(workspaceId,ownerSubject) {
  const rows=sampleRows(workspaceId,ownerSubject);
  const guard=`EXISTS (SELECT 1 FROM workspace_members WHERE workspace_id=${quote(workspaceId)} AND identity_subject=${quote(ownerSubject)} AND role='owner' AND status='active')`;
  return Object.entries(rows).flatMap(([table,records])=>records.map(row=>{
    const keys=Object.keys(row);
    const references={company_id:'companies',point_of_contact_id:'contacts',contact_id:'contacts',opportunity_id:'opportunities',pipeline_id:'pipelines'};
    const checks=Object.entries(references).filter(([key])=>row[key]).map(([key,target])=>`EXISTS (SELECT 1 FROM ${target} WHERE id=${quote(row[key])} AND workspace_id=${quote(workspaceId)})`);
    return `INSERT INTO ${table} (${keys.join(',')}) SELECT ${keys.map(key=>quote(row[key])).join(',')} WHERE ${[guard,...checks].join(' AND ')} ON CONFLICT(id) DO NOTHING;`;
  })).join('\n');
}

// CLI dry-run is the default; production writes require --apply --remote.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2);
  const value=flag=>args[args.indexOf(flag)+1];
  const workspace=args.includes('--workspace')?value('--workspace'):'';
  const owner=args.includes('--owner')?value('--owner'):'';
  const apply=args.includes('--apply');
  const remote=args.includes('--remote');
  const rows=sampleRows(workspace,owner);
  const summary=Object.fromEntries(Object.entries(rows).map(([table,records])=>[table,records.length]));
  if (!apply) { console.log(JSON.stringify({mode:'manifest-only-dry-run',remoteChecksPerformed:false,workspace,seed:SEED_KEY,counts:summary,total:19},null,2)); process.exit(0); }
  if(!remote) throw new Error('Production apply requires explicit --remote (use local SQLite tests for fixtures)');
  const run=sql=>JSON.parse(execFileSync('pnpm',['exec','wrangler','d1','execute','CRM_DB','--remote','--command',sql,'--json'],{cwd:fileURLToPath(new URL('../',import.meta.url)),encoding:'utf8',stdio:['ignore','pipe','inherit']}));
  const resultRows=result=>result.flatMap(item=>item.results??[]);
  const membership=resultRows(run(`SELECT role,status FROM workspace_members WHERE workspace_id=${quote(workspace)} AND identity_subject=${quote(owner)}`));
  if(membership.length!==1 || membership[0].role!=='owner' || membership[0].status!=='active') throw new Error('Target must have the specified active native owner');
  // Detect impossible/hostile ID collisions before inserting related records.
  for(const [table,records] of Object.entries(rows)) {
    const conflicting=resultRows(run(`SELECT COUNT(*) AS count FROM ${table} WHERE id IN (${records.map(row=>quote(row.id)).join(',')}) AND workspace_id<>${quote(workspace)}`));
    if(Number(conflicting[0]?.count)!==0) throw new Error(`Seed ID collision in ${table}; no records inserted`);
  }
  run(seedSql(workspace,owner));
  const counts={};
  for(const [table,records] of Object.entries(rows)) {
    const verified=resultRows(run(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id=${quote(workspace)} AND id IN (${records.map(row=>quote(row.id)).join(',')})`));
    counts[table]=Number(verified[0]?.count);
    if(counts[table]!==records.length) throw new Error(`Seed count mismatch in ${table}; retry is safe (no overwrites)`);
  }
  const invalid=resultRows(run(`SELECT COUNT(*) AS count FROM opportunities o LEFT JOIN companies c ON c.id=o.company_id AND c.workspace_id=o.workspace_id LEFT JOIN contacts p ON p.id=o.point_of_contact_id AND p.workspace_id=o.workspace_id LEFT JOIN pipelines l ON l.id=o.pipeline_id AND l.workspace_id=o.workspace_id WHERE o.workspace_id=${quote(workspace)} AND o.id IN (${rows.opportunities.map(row=>quote(row.id)).join(',')}) AND (c.id IS NULL OR p.id IS NULL OR l.id IS NULL)`));
  if(Number(invalid[0]?.count)!==0) throw new Error('Sample relationship verification failed');
  const invalidActivities=resultRows(run(`SELECT COUNT(*) AS count FROM activities a LEFT JOIN companies c ON c.id=a.company_id AND c.workspace_id=a.workspace_id LEFT JOIN contacts p ON p.id=a.contact_id AND p.workspace_id=a.workspace_id LEFT JOIN opportunities o ON o.id=a.opportunity_id AND o.workspace_id=a.workspace_id WHERE a.workspace_id=${quote(workspace)} AND a.id IN (${rows.activities.map(row=>quote(row.id)).join(',')}) AND (c.id IS NULL OR p.id IS NULL OR o.id IS NULL)`));
  if(Number(invalidActivities[0]?.count)!==0) throw new Error('Sample activity relationship verification failed');
  console.log(JSON.stringify({mode:'applied-and-verified',workspace,seed:SEED_KEY,counts,total:19},null,2));
}
