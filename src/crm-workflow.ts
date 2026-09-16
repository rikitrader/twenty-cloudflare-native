import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./types";

export interface CrmExportParams { workspaceId: string; objectType: string; exportId: string }

export class CrmExportWorkflow extends WorkflowEntrypoint<Env, CrmExportParams> {
  async run(event: WorkflowEvent<CrmExportParams>, step: WorkflowStep) {
    const { workspaceId, objectType, exportId } = event.payload;
    const tables: Record<string, string> = { contact: "contacts", company: "companies", opportunity: "opportunities", activity: "activities" };
    await this.env.CRM_DB!.prepare("UPDATE crm_exports SET status = 'running', updated_at = ? WHERE id = ? AND workspace_id = ?").bind(new Date().toISOString(), exportId, workspaceId).run();
    try {
    const data = await step.do("read-d1", async () => {
      const result: Record<string, any[]> = {};
      for (const [type, table] of Object.entries(tables)) {
        if (objectType !== "all" && objectType !== type) continue;
        result[type] = (await this.env.CRM_DB!.prepare(`SELECT * FROM ${table} WHERE workspace_id = ? LIMIT 10000`).bind(workspaceId).all()).results;
      }
      return result;
    });
    return await step.do("write-r2", async () => {
      const exportedAt = new Date().toISOString(); const key = `exports/${workspaceId}/${exportId}.json`;
      const payload = JSON.stringify({ schemaVersion: 1, workspaceId, exportedAt, data });
      await this.env.STORAGE.put(key, payload, { httpMetadata: { contentType: "application/json" }, customMetadata: { workspaceId, exportId } });
      await this.env.CRM_DB!.prepare("UPDATE crm_exports SET status = 'complete', object_key = ?, bytes = ?, updated_at = ? WHERE id = ? AND workspace_id = ?").bind(key, payload.length, new Date().toISOString(), exportId, workspaceId).run();
      return { key, bytes: payload.length, exportedAt };
    });
    } catch (error) {
      await this.env.CRM_DB!.prepare("UPDATE crm_exports SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND workspace_id = ?").bind(String(error).slice(0, 500), new Date().toISOString(), exportId, workspaceId).run();
      throw error;
    }
  }
}
