import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./types";
import { writeCrmExport, type CrmExportParams } from "./crm-export";
import { processImportChunk, type CrmImportParams } from './crm-import';

export class CrmExportWorkflow extends WorkflowEntrypoint<Env, CrmExportParams> {
  async run(event: WorkflowEvent<CrmExportParams>, step: WorkflowStep) {
    const { workspaceId, exportId } = event.payload;
    const accepted = await this.env.CRM_DB!.prepare("UPDATE crm_exports SET status='running',error=NULL,updated_at=? WHERE id=? AND workspace_id=? AND status='queued'").bind(new Date().toISOString(), exportId, workspaceId).run();
    if (Number(accepted.meta?.changes ?? 0) !== 1) return { cancelled: true };
    try {
      const result = await step.do("write-paginated-r2-export", async () => writeCrmExport(this.env, event.payload));
      const current = await this.env.CRM_DB!.prepare("SELECT status FROM crm_exports WHERE id=? AND workspace_id=?").bind(exportId, workspaceId).first<{ status: string }>();
      if (current?.status === "cancelled") return { cancelled: true };
      await this.env.CRM_DB!.prepare("UPDATE crm_exports SET status='complete',object_key=?,bytes=?,updated_at=? WHERE id=? AND workspace_id=? AND status='running'").bind(result.key, result.bytes, new Date().toISOString(), exportId, workspaceId).run();
      return result;
    } catch (error) {
      const cancelled = String(error).includes("export cancelled");
      if (!cancelled) await this.env.CRM_DB!.prepare("UPDATE crm_exports SET status='failed',error=?,updated_at=? WHERE id=? AND workspace_id=? AND status!='cancelled'").bind(String(error).slice(0, 500), new Date().toISOString(), exportId, workspaceId).run();
      if (cancelled) return { cancelled: true }; throw error;
    }
  }
}

export class CrmImportWorkflow extends WorkflowEntrypoint<Env, CrmImportParams> {
  async run(event:WorkflowEvent<CrmImportParams>,step:WorkflowStep){
    const{workspaceId,importId}=event.payload;const accepted=await this.env.CRM_DB!.prepare("UPDATE migration_runs SET status='running',error=NULL,updated_at=? WHERE id=? AND workspace_id=? AND status='pending'").bind(new Date().toISOString(),importId,workspaceId).run();if(Number(accepted.meta?.changes??0)!==1)return{cancelled:true};
    try{for(let batch=0;batch<10000;batch++){const result=await step.do(`import-r2-chunk-${batch}`,async()=>processImportChunk(this.env,event.payload));if(result.done)return result;}throw new Error('import exceeded workflow batch limit');}
    catch(error){await this.env.CRM_DB!.prepare("UPDATE migration_runs SET status='failed',error=?,updated_at=? WHERE id=? AND workspace_id=? AND status!='cancelled'").bind(String(error).slice(0,500),new Date().toISOString(),importId,workspaceId).run();throw error;}
  }
}
