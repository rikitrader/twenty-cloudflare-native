export const RELEASE_MAINTENANCE_KEY = "release:maintenance";
export const RELEASE_DEPLOYMENT_EVENT = "deployment-result";

export const RELEASE_STATES = [
  "preflight",
  "maintenance",
  "backup_verified",
  "migrating",
  "ready_to_deploy",
  "verifying_deployment",
  "deployed",
  "failed",
  "needs_review",
] as const;

export type ReleaseState = (typeof RELEASE_STATES)[number];

export interface ReleaseParams {
  releaseId: string;
  gitSha: string;
  appImageDigest: string;
  appVersion: string;
}

export interface ReleaseMaintenance {
  schemaVersion: 1;
  releaseId: string;
  reason: "database-release";
  startedAt: string;
}

export interface ReleaseDeploymentResult {
  releaseId: string;
  gitSha: string;
  appImageDigest: string;
  success: boolean;
  cloudflareVersionId?: string;
  checks?: Record<string, boolean>;
  error?: string;
}

export interface ReleaseRunRecord {
  release_id: string;
  git_sha: string;
  app_image_digest: string;
  app_version: string;
  state: ReleaseState;
  branch_id: string | null;
  backup_workflow_id: string | null;
  backup_r2_key: string | null;
  cloudflare_version_id: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ProductionReleaseControl {
  setMaintenance(record: ReleaseMaintenance): Promise<void>;
  getMaintenance(): Promise<ReleaseMaintenance | null>;
  clearMaintenance(releaseId: string): Promise<boolean>;
  quiesce(releaseId: string): Promise<{ releaseId: string; stopped: true }>;
  startBackup(releaseId: string): Promise<{ workflowId: string }>;
  backupStatus(workflowId: string): Promise<{
    status: string;
    artifact?: { key: string; sha256: string };
    error?: { name?: string; message?: string };
  }>;
  deploymentIdentity(): Promise<{
    versionId: string | null;
    versionTag: string | null;
  }>;
  verifyRelease(releaseId: string): Promise<{
    versionId: string | null;
    serverReady: boolean;
    workerReady: boolean;
  }>;
  migrationRuntime(
    releaseId: string,
    target: "preflight" | "production",
  ): Promise<{
    pgDatabaseUrl?: string;
    internalServiceToken: string;
    encryptionKey: string;
    fallbackEncryptionKey?: string;
    appSecret?: string;
  }>;
}
