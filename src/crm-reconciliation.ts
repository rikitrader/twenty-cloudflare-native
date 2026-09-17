import type {Env} from './types';

const tables={contact:'contacts',company:'companies',pipeline:'pipelines',opportunity:'opportunities',activity:'activities',task:'crm_tasks',note:'crm_notes',file:'crm_files',customObject:'custom_objects',customField:'custom_fields',taskTarget:'crm_task_targets',noteTarget:'crm_note_targets',attachment:'crm_attachments',fileLink:'crm_file_links',relationship:'record_relationships',customRecord:'custom_records',view:'saved_views'} as const;
const validHash=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);

export async function reconcileMigration(env:Env,workspaceId:string,sourceManifestSha256:unknown,expected:unknown){
  if(!validHash(sourceManifestSha256)||!expected||typeof expected!=='object'||Array.isArray(expected))throw new Error('sourceManifestSha256 and expectedCounts are required');const expectedCounts=expected as Record<string,unknown>,targetCounts:Record<string,number>={};
  for(const[type,table]of Object.entries(tables)){const row=await env.CRM_DB!.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id=?`).bind(workspaceId).first<{count:number}>();targetCounts[type]=Number(row?.count??0);}
  let countMismatches=0;for(const[type,count]of Object.entries(expectedCounts)){if(!(type in tables)||!Number.isSafeInteger(count)||Number(count)<0)throw new Error(`invalid expected count for ${type}`);if(targetCounts[type]!==Number(count))countMismatches++;}
  const brokenRelationships=await env.CRM_DB!.prepare(`SELECT COUNT(*) AS count FROM record_relationships r WHERE r.workspace_id=? AND (
    (r.source_type IN ('contact','person') AND NOT EXISTS(SELECT 1 FROM contacts x WHERE x.workspace_id=r.workspace_id AND x.id=r.source_id)) OR
    (r.source_type='company' AND NOT EXISTS(SELECT 1 FROM companies x WHERE x.workspace_id=r.workspace_id AND x.id=r.source_id)) OR
    (r.source_type='opportunity' AND NOT EXISTS(SELECT 1 FROM opportunities x WHERE x.workspace_id=r.workspace_id AND x.id=r.source_id)) OR
    (r.source_type='activity' AND NOT EXISTS(SELECT 1 FROM activities x WHERE x.workspace_id=r.workspace_id AND x.id=r.source_id)) OR
    (r.source_type='task' AND NOT EXISTS(SELECT 1 FROM crm_tasks x WHERE x.workspace_id=r.workspace_id AND x.id=r.source_id)) OR
    (r.source_type='note' AND NOT EXISTS(SELECT 1 FROM crm_notes x WHERE x.workspace_id=r.workspace_id AND x.id=r.source_id)) OR
    (r.target_type IN ('contact','person') AND NOT EXISTS(SELECT 1 FROM contacts x WHERE x.workspace_id=r.workspace_id AND x.id=r.target_id)) OR
    (r.target_type='company' AND NOT EXISTS(SELECT 1 FROM companies x WHERE x.workspace_id=r.workspace_id AND x.id=r.target_id)) OR
    (r.target_type='opportunity' AND NOT EXISTS(SELECT 1 FROM opportunities x WHERE x.workspace_id=r.workspace_id AND x.id=r.target_id)) OR
    (r.target_type='activity' AND NOT EXISTS(SELECT 1 FROM activities x WHERE x.workspace_id=r.workspace_id AND x.id=r.target_id)) OR
    (r.target_type='task' AND NOT EXISTS(SELECT 1 FROM crm_tasks x WHERE x.workspace_id=r.workspace_id AND x.id=r.target_id)) OR
    (r.target_type='note' AND NOT EXISTS(SELECT 1 FROM crm_notes x WHERE x.workspace_id=r.workspace_id AND x.id=r.target_id))
  )`).bind(workspaceId).first<{count:number}>();
  const brokenAttachments=await env.CRM_DB!.prepare(`SELECT COUNT(*) AS count FROM crm_attachments a WHERE a.workspace_id=? AND (
    NOT EXISTS(SELECT 1 FROM crm_files f WHERE f.workspace_id=a.workspace_id AND f.id=a.file_id) OR
    (a.target_type='person' AND NOT EXISTS(SELECT 1 FROM contacts x WHERE x.workspace_id=a.workspace_id AND x.id=a.target_id)) OR
    (a.target_type='company' AND NOT EXISTS(SELECT 1 FROM companies x WHERE x.workspace_id=a.workspace_id AND x.id=a.target_id)) OR
    (a.target_type='opportunity' AND NOT EXISTS(SELECT 1 FROM opportunities x WHERE x.workspace_id=a.workspace_id AND x.id=a.target_id)) OR
    (a.target_type='activity' AND NOT EXISTS(SELECT 1 FROM activities x WHERE x.workspace_id=a.workspace_id AND x.id=a.target_id)) OR
    (a.target_type='task' AND NOT EXISTS(SELECT 1 FROM crm_tasks x WHERE x.workspace_id=a.workspace_id AND x.id=a.target_id)) OR
    (a.target_type='note' AND NOT EXISTS(SELECT 1 FROM crm_notes x WHERE x.workspace_id=a.workspace_id AND x.id=a.target_id))
  )`).bind(workspaceId).first<{count:number}>();
  let missingR2Objects=0,offset=0;for(;;){const page=await env.CRM_DB!.prepare('SELECT object_key as objectKey FROM crm_files WHERE workspace_id=? ORDER BY id LIMIT 250 OFFSET ?').bind(workspaceId,offset).all<{objectKey:string}>();for(const row of page.results)if(!await env.STORAGE.head(row.objectKey))missingR2Objects++;if(page.results.length<250)break;offset+=page.results.length;if(offset>100_000)throw new Error('file reconciliation exceeds safety limit');}
  const relationshipErrors=Number(brokenRelationships?.count??0)+Number(brokenAttachments?.count??0),status=countMismatches||relationshipErrors||missingR2Objects?'failed':'passed',id=crypto.randomUUID(),createdAt=new Date().toISOString(),report={id,workspaceId,sourceManifestSha256,expectedCounts,targetCounts,countMismatches,relationshipErrors,missingR2Objects,status,createdAt},key=`reconciliations/${workspaceId}/${id}.json`;await env.STORAGE.put(key,JSON.stringify(report),{httpMetadata:{contentType:'application/json'},customMetadata:{workspaceId,reconciliationId:id}});await env.CRM_DB!.prepare('INSERT INTO migration_reconciliations (id,workspace_id,source_manifest_sha256,source_counts_json,target_counts_json,relationship_errors,missing_r2_objects,status,report_object_key,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').bind(id,workspaceId,sourceManifestSha256,JSON.stringify(expectedCounts),JSON.stringify(targetCounts),relationshipErrors,missingR2Objects,status,key,createdAt).run();return report;
}
