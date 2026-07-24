import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import { backupKey, sanitizedErrorMessage, shouldSkipBackup } from "./lib";
import type { Env } from "./types";

export interface BackupParams {
  force?: boolean;
}

/**
 * Durable backup pipeline (CF Workflows):
 *   check-idle → dump via DO tunnel → R2 put → verify → D1 ledger
 * Each step retries independently; a dump that races the boot-time restore
 * returns 503 from the agent and is retried by the step engine.
 */
export class BackupWorkflow extends WorkflowEntrypoint<Env, BackupParams> {
  async run(event: WorkflowEvent<BackupParams>, step: WorkflowStep) {
    const skip = await step.do("check-idle", async () => {
      if (event.payload?.force) return "";
      const status = await this.env.STATUS_KV.get("status");
      const lastBackup = await this.env.STATUS_KV.get("last-backup");
      const lastActivity = status
        ? (JSON.parse(status) as { checked?: string }).checked ?? null
        : null;
      return shouldSkipBackup(lastActivity, lastBackup) ? "idle" : "";
    });
    if (skip) return { skipped: skip };

    await step.do("record-attempt", async () => {
      await this.env.STATUS_KV.put(
        "last-backup-attempt",
        new Date(event.timestamp).toISOString(),
      );
    });

    let key: string;
    try {
      key = await step.do(
        "dump-to-r2",
        { retries: { limit: 5, delay: "30 seconds", backoff: "exponential" } },
        async () => {
          const stub = getContainer(this.env.TWENTY, "main");
          const res = await stub.fetch(
            new Request("https://container/_agent/dump"),
          );
          if (!res.ok) throw new Error(`dump failed: HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          if (buf.byteLength < 1024)
            throw new Error(`dump suspiciously small: ${buf.byteLength}B`);
          const k = backupKey(new Date(event.timestamp));
          await this.env.STORAGE.put(k, buf);
          return k;
        },
      );
    } catch (error) {
      await step.do("record-failure", async () => {
        await this.env.STATUS_KV.put(
          "last-backup-error",
          sanitizedErrorMessage(error),
        );
      });
      throw error;
    }

    await step.do("verify-and-ledger", async () => {
      const head = await this.env.STORAGE.head(key);
      if (!head || head.size === 0) throw new Error(`verify failed for ${key}`);
      await this.env.OPS_DB.prepare(
        "INSERT INTO backups (r2_key, bytes, status) VALUES (?, ?, ?)",
      )
        .bind(key, head.size, "ok")
        .run();
      await this.env.STATUS_KV.put("last-backup", new Date().toISOString());
      await this.env.STATUS_KV.delete("last-backup-error");
    });

    return { key };
  }
}
