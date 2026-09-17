import type { Env } from "./types";

export interface CrmExportParams { workspaceId: string; objectType: string; exportId: string }
const PAGE_SIZE=500,MIN_PART_BYTES=5*1024*1024;
// Dependency order is also the supported re-import order: parents and R2 file
// metadata precede targets, attachments, links, relationships and records.
const exportTables={contact:'contacts',company:'companies',pipeline:'pipelines',opportunity:'opportunities',activity:'activities',task:'crm_tasks',note:'crm_notes',file:'crm_files',customObject:'custom_objects',customField:'custom_fields',taskTarget:'crm_task_targets',noteTarget:'crm_note_targets',attachment:'crm_attachments',fileLink:'crm_file_links',relationship:'record_relationships',customRecord:'custom_records',view:'saved_views'} as const;
type ExportType=keyof typeof exportTables;
const selectedTables=(objectType:string):[ExportType,string][]=>{const entries=Object.entries(exportTables) as [ExportType,string][];return objectType==='all'?entries:entries.filter(([type])=>type===objectType);};
function joinBytes(chunks:Uint8Array[],size:number){const output=new Uint8Array(size);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.byteLength;}return output;}

export async function writeCrmExport(env:Env,params:CrmExportParams):Promise<{key:string;bytes:number;records:number;exportedAt:string}>{
  const{workspaceId,objectType,exportId}=params,tables=selectedTables(objectType);if(!tables.length)throw new Error(`Unsupported export object type: ${objectType}`);
  const exportedAt=new Date().toISOString(),key=`exports/${workspaceId}/${exportId}.ndjson`,upload=await env.STORAGE.createMultipartUpload(key,{httpMetadata:{contentType:'application/x-ndjson'},customMetadata:{workspaceId,exportId,schemaVersion:'2'}});
  const encoder=new TextEncoder(),parts:R2UploadedPart[]=[];let chunks:Uint8Array[]=[],bufferedBytes=0,bytes=0,records=0,partNumber=1;
  const append=(line:string)=>{const chunk=encoder.encode(line);chunks.push(chunk);bufferedBytes+=chunk.byteLength;bytes+=chunk.byteLength;};
  const flush=async()=>{if(!bufferedBytes)return;parts.push(await upload.uploadPart(partNumber++,joinBytes(chunks,bufferedBytes)));chunks=[];bufferedBytes=0;};
  try{
    append(JSON.stringify({kind:'manifest',schemaVersion:2,workspaceId,exportedAt,objectType,tables:tables.map(([type])=>type)})+'\n');
    for(const[type,table]of tables){let afterRowId=0;for(;;){const current=await env.CRM_DB!.prepare('SELECT status FROM crm_exports WHERE id=? AND workspace_id=?').bind(exportId,workspaceId).first<{status:string}>();if(current?.status==='cancelled')throw new Error('export cancelled');const page=await env.CRM_DB!.prepare(`SELECT rowid AS __export_rowid,* FROM ${table} WHERE workspace_id=? AND rowid>? ORDER BY rowid LIMIT ?`).bind(workspaceId,afterRowId,PAGE_SIZE).all<Record<string,unknown>>();for(const raw of page.results){const{__export_rowid,...record}=raw;append(JSON.stringify({kind:'record',objectType:type,record})+'\n');records++;if(bufferedBytes>=MIN_PART_BYTES)await flush();}if(page.results.length<PAGE_SIZE)break;afterRowId=Number(page.results.at(-1)?.__export_rowid??0);if(!Number.isSafeInteger(afterRowId)||afterRowId<1)throw new Error(`Export table ${table} returned an invalid row cursor`);}}
    append(JSON.stringify({kind:'summary',schemaVersion:2,records,bytesBeforeSummary:bytes})+'\n');await flush();await upload.complete(parts);return{key,bytes,records,exportedAt};
  }catch(error){await upload.abort().catch(()=>undefined);throw error;}
}
