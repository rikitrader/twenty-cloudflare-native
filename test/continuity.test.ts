import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { afterEach,beforeEach,expect,it } from 'vitest';
import { collectOperationalContinuity, operationalContinuityStatus } from '../src/continuity';
import type { Env } from '../src/types';

let crm:DatabaseSync;let ops:DatabaseSync;let env:Env;
const adapter=(db:DatabaseSync)=>({prepare:(sql:string)=>({bind:(...values:unknown[])=>{const statement=db.prepare(sql);return{first:async()=>statement.get(...values as never[])??null,all:async()=>({results:statement.all(...values as never[])}),run:async()=>({success:true,meta:statement.run(...values as never[])})};},first:async()=>db.prepare(sql).get()??null})});
beforeEach(()=>{
  crm=new DatabaseSync(':memory:');ops=new DatabaseSync(':memory:');
  const migrations=readdirSync(new URL('../migrations/',import.meta.url)).filter(name=>name.endsWith('.sql')).sort();
  for(const name of migrations){const sql=readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8');crm.exec(sql);ops.exec(sql);}
  env={CRM_DB:adapter(crm),OPS_DB:adapter(ops),AI:{},CRM_EMAIL:{},CRM_EMAIL_FROM:'crm@example.test',ACCESS_REQUIRED:'true',ACCESS_TEAM_DOMAIN:'https://team.cloudflareaccess.com',ACCESS_AUD:'aud',WEBHOOK_TOKEN:'in',OUTBOUND_WEBHOOK_SECRET:'out',WEBHOOK_ALLOWED_HOSTS:'receiver.example.test'} as unknown as Env;
});
afterEach(()=>{crm.close();ops.close();});

it('persists a real passing operational sample without treating optional providers as required',async()=>{
  const sample=await collectOperationalContinuity(env,Date.parse('2026-09-17T00:00:00.000Z'));
  expect(sample).toMatchObject({crmD1Ok:true,opsD1Ok:true,newQuarantinedJobs:0,staleOutboxEvents:0,passed:true});
  expect(sample.providers.google).toMatchObject({configured:false,evidence:'not_configured'});
  expect(ops.prepare('SELECT passed FROM operational_continuity_samples').get()).toEqual({passed:1});
});

it('requires actual seven-day elapsed time and resets the clean window on failure or a large gap',async()=>{
  const insert=ops.prepare('INSERT INTO operational_continuity_samples VALUES (?,?,?,?,?,?,?,?,?,?)');
  const start=Date.parse('2026-09-10T00:00:00.000Z');
  for(let index=0;index<673;index++){
    const at=new Date(start+index*15*60_000).toISOString();
    insert.run(`sample-${index}`,at,'version',1,1,0,0,'{}',1,'{}');
  }
  let response=await operationalContinuityStatus(env);let body=await response.json() as any;
  expect(body).toMatchObject({ready:true,status:'passed',consecutivePassedSamples:673,durationMs:604800000});
  insert.run('failure',new Date(start+673*15*60_000).toISOString(),'version',1,1,1,0,'{}',0,'{}');
  response=await operationalContinuityStatus(env);body=await response.json() as any;
  expect(body).toMatchObject({ready:false,status:'collecting',consecutivePassedSamples:0});
});
