import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import { backupKey, sanitizedErrorMessage, shouldSkipBackup } from "./lib";
import {
  backupManifestKey,
  checksumHex,
  createBackupManifest,
  isSha256Hex,
} from "./backup-manifest";
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
      const lastActivity =
        await this.env.STATUS_KV.get("last-customer-activity");
      const lastBackup = await this.env.STATUS_KV.get("last-backup");
      return shouldSkipBackup(lastActivity, lastBackup) ? "idle" : "";
    });
    if (skip) return { skipped: skip };

    await step.do("record-attempt", async () => {
      await this.env.STATUS_KV.put(
        "last-backup-attempt",
        new Date(event.timestamp).toISOString(),
      );
    });

    let artifact: {
      key: string;
      manifestKey: string;
      bytes: number;
      sha256: string;
      createdAt: string;
    };
    try {
      artifact = await step.do(
        "dump-to-r2",
        { retries: { limit: 5, delay: "30 seconds", backoff: "exponential" } },
        async () => {
          const stub = getContainer(this.env.BACKUP_CONTAINER, "main");
          const res = await stub.fetch(
            new Request("https://container/_agent/dump"),
          );
          if (!res.ok) throw new Error(`dump failed: HTTP ${res.status}`);
          const bytes = Number(res.headers.get("content-length"));
          const sha256 = res.headers.get("x-backup-sha256");
          if (!Number.isSafeInteger(bytes) || bytes < 1024)
            throw new Error(`dump suspiciously small: ${bytes}B`);
          if (!isSha256Hex(sha256))
            throw new Error("dump did not provide a valid SHA-256 digest");
          if (!res.body) throw new Error("dump response has no body");

          const createdAt = new Date(event.timestamp).toISOString();
          const key = backupKey(new Date(event.timestamp));
          const manifestKey = backupManifestKey(key);
          const fixedLength = new FixedLengthStream(bytes);
          const bodyTransfer = res.body.pipeTo(fixedLength.writable);
          const stored = await this.env.STORAGE.put(key, fixedLength.readable, {
            sha256,
            httpMetadata: { contentType: "application/sql" },
            customMetadata: {
              backupSchemaVersion: "1",
              createdAt,
              sha256,
              sourceEngine: "postgresql",
            },
          });
          await bodyTransfer;
          if (!stored) throw new Error(`R2 put failed for ${key}`);

          const manifest = createBackupManifest({
            createdAt,
            key,
            bytes,
            sha256,
          });
          await this.env.STORAGE.put(
            manifestKey,
            JSON.stringify(manifest, null, 2),
            {
              httpMetadata: { contentType: "application/json" },
              customMetadata: {
                backupSchemaVersion: "1",
                artifactKey: key,
                sha256,
              },
            },
          );
          return { key, manifestKey, bytes, sha256, createdAt };
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
      const [head, manifestObject] = await Promise.all([
        this.env.STORAGE.head(artifact.key),
        this.env.STORAGE.get(artifact.manifestKey),
      ]);
      if (
        !head ||
        head.size !== artifact.bytes ||
        checksumHex(head.checksums.sha256) !== artifact.sha256
      )
        throw new Error(`artifact verify failed for ${artifact.key}`);
      if (!manifestObject)
        throw new Error(`manifest missing for ${artifact.key}`);
      const manifest = createBackupManifest({
        createdAt: artifact.createdAt,
        key: artifact.key,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
      });
      if (JSON.stringify(await manifestObject.json()) !== JSON.stringify(manifest))
        throw new Error(`manifest verify failed for ${artifact.key}`);
      await this.env.OPS_DB.prepare(
        `INSERT INTO backups
          (r2_key, bytes, status, manifest_key, sha256)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(
          artifact.key,
          artifact.bytes,
          "verified",
          artifact.manifestKey,
          artifact.sha256,
        )
        .run();
      await this.env.STATUS_KV.put("last-backup", new Date().toISOString());
      await this.env.STATUS_KV.delete("last-backup-error");
    });

    return artifact;
  }
}
