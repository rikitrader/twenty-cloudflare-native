import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { getContainer } from "../container-compat";
import {
  RELEASE_DEPLOYMENT_EVENT,
  type ReleaseDeploymentResult,
  type ReleaseParams,
} from "../release-contracts";
import { sanitizedErrorMessage } from "../lib";
import {
  acquireReleaseLock,
  deployedImageExists,
  ensureRelease,
  releaseReleaseLock,
  transitionRelease,
} from "./ledger";
import {
  createReleaseBranch,
  deleteReleaseBranch,
  type NeonBranchTarget,
} from "./neon";
import type {
  ReleaseAgentRequest,
  ReleaseAgentStatus,
} from "./container";
import type { ReleaseEnv } from "./types";

function validateParams(input: ReleaseParams): void {
  if (!/^[a-zA-Z0-9._-]{8,100}$/.test(input.releaseId))
    throw new Error("invalid releaseId");
  if (!/^[a-f0-9]{40}$/.test(input.gitSha))
    throw new Error("invalid gitSha");
  if (!/^sha256:[a-f0-9]{64}$/.test(input.appImageDigest))
    throw new Error("invalid appImageDigest");
  if (
    typeof input.appVersion !== "string" ||
    input.appVersion.length < 1 ||
    input.appVersion.length > 100
  )
    throw new Error("invalid appVersion");
}

async function startReleaseAgent(
  env: ReleaseEnv,
  releaseId: string,
  request: Omit<ReleaseAgentRequest, "runtime">,
): Promise<void> {
  const runtime = await env.PRODUCTION.migrationRuntime(
    releaseId,
    request.phase,
  );
  const databaseUrl =
    request.phase === "production"
      ? runtime.pgDatabaseUrl
      : request.databaseUrl;
  if (!databaseUrl) throw new Error("migration database URL is unavailable");
  const container = getContainer(env.RELEASE_CONTAINER, "main");
  const response = await container.fetch(
    new Request("http://release-container/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...request,
        databaseUrl,
        runtime: {
          internalServiceToken: runtime.internalServiceToken,
          encryptionKey: runtime.encryptionKey,
          ...(runtime.fallbackEncryptionKey
            ? { fallbackEncryptionKey: runtime.fallbackEncryptionKey }
            : {}),
          ...(runtime.appSecret ? { appSecret: runtime.appSecret } : {}),
        },
      } satisfies ReleaseAgentRequest),
    }),
  );
  if (!response.ok)
    throw new Error(`release agent start failed: HTTP ${response.status}`);
}

async function releaseAgentStatus(
  env: ReleaseEnv,
): Promise<ReleaseAgentStatus> {
  const response = await getContainer(env.RELEASE_CONTAINER, "main").fetch(
    new Request("http://release-container/status"),
  );
  if (!response.ok)
    throw new Error(`release agent status failed: HTTP ${response.status}`);
  return response.json<ReleaseAgentStatus>();
}

async function destroyReleaseAgent(env: ReleaseEnv): Promise<void> {
  await getContainer(env.RELEASE_CONTAINER, "main").destroy();
}

async function runMigration(
  step: WorkflowStep,
  env: ReleaseEnv,
  name: string,
  releaseId: string,
  request: Omit<ReleaseAgentRequest, "runtime">,
): Promise<void> {
  await step.do(
    `${name}-start`,
    { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
    async () => startReleaseAgent(env, releaseId, request),
  );
  await step.do(
    `${name}-wait`,
    {
      retries: { limit: 80, delay: "15 seconds", backoff: "constant" },
      timeout: "2 minutes",
    },
    async () => {
      const status = await releaseAgentStatus(env);
      if (status.requestId !== request.requestId)
        throw new Error("release agent request identity mismatch");
      if (status.status === "running")
        throw new Error("release agent is still running");
      if (status.status === "failed")
        throw new Error(status.error || "release agent failed");
      if (status.status !== "complete")
        throw new Error(`unexpected release agent state: ${status.status}`);
    },
  );
  await step.do(`${name}-destroy`, async () => destroyReleaseAgent(env));
}

export class TwentyReleaseWorkflow extends WorkflowEntrypoint<
  ReleaseEnv,
  ReleaseParams
> {
  async run(event: WorkflowEvent<ReleaseParams>, step: WorkflowStep) {
    const params = event.payload;
    let branch: NeonBranchTarget | null = null;
    let maintenanceEntered = false;
    let productionMutationStarted = false;
    let lockAcquired = false;

    try {
      await step.do("validate-release", async () => {
        validateParams(params);
        await ensureRelease(this.env.OPS_DB, params);
      });

      const databaseAlreadyReleased = await step.do(
        "check-image-ledger",
        async () =>
          deployedImageExists(this.env.OPS_DB, params.appImageDigest),
      );

      if (!databaseAlreadyReleased) {
        branch = await step.do(
          "create-neon-preflight-branch",
          { sensitive: "output" },
          async () => {
            const target = await createReleaseBranch(
              this.env,
              params.releaseId,
            );
            await transitionRelease(
              this.env.OPS_DB,
              params.releaseId,
              "preflight",
              { branchId: target.branchId },
            );
            return target;
          },
        );

        await runMigration(step, this.env, "preflight-migration", params.releaseId, {
          requestId: `${params.releaseId}.preflight`,
          databaseUrl: branch.databaseUrl,
          phase: "preflight",
        });
        await step.do("delete-neon-preflight-branch", async () => {
          if (branch)
            await deleteReleaseBranch(this.env, branch.branchId);
        });
        branch = null;

        await step.do("acquire-production-release-lock", async () => {
          await acquireReleaseLock(this.env.OPS_DB, params.releaseId);
        });
        lockAcquired = true;

        await step.do("enter-maintenance", async () => {
          await this.env.PRODUCTION.setMaintenance({
            schemaVersion: 1,
            releaseId: params.releaseId,
            reason: "database-release",
            startedAt: new Date().toISOString(),
          });
          await this.env.PRODUCTION.quiesce(params.releaseId);
          await transitionRelease(
            this.env.OPS_DB,
            params.releaseId,
            "maintenance",
          );
        });
        maintenanceEntered = true;

        // KV is intentionally off the normal request's critical path via a
        // short isolate cache. Give the maintenance marker propagation time,
        // then destroy both application Containers again before mutation.
        await step.sleep("maintenance-propagation", "1 minute");
        await step.do("confirm-quiesced", async () => {
          await this.env.PRODUCTION.quiesce(params.releaseId);
        });

        const backup = await step.do("start-release-backup", async () => {
          const started = await this.env.PRODUCTION.startBackup(
            params.releaseId,
          );
          await transitionRelease(
            this.env.OPS_DB,
            params.releaseId,
            "maintenance",
            { backupWorkflowId: started.workflowId },
          );
          return started;
        });
        const backupArtifact = await step.do(
          "wait-for-verified-release-backup",
          {
            retries: {
              limit: 40,
              delay: "15 seconds",
              backoff: "constant",
            },
          },
          async () => {
            const status = await this.env.PRODUCTION.backupStatus(
              backup.workflowId,
            );
            if (
              status.status === "queued" ||
              status.status === "running" ||
              status.status === "waiting"
            )
              throw new Error("release backup is still running");
            if (status.status !== "complete")
              throw new Error(
                status.error?.message ||
                  `release backup ended in ${status.status}`,
              );
            if (!status.artifact)
              throw new Error("release backup did not return a verified artifact");
            return status.artifact;
          },
        );
        await step.do("record-verified-release-backup", async () => {
          await transitionRelease(
            this.env.OPS_DB,
            params.releaseId,
            "backup_verified",
            { backupR2Key: backupArtifact.key },
          );
        });

        productionMutationStarted = true;
        await step.do("record-production-migration-start", async () => {
          await transitionRelease(
            this.env.OPS_DB,
            params.releaseId,
            "migrating",
          );
        });
        await runMigration(step, this.env, "production-migration", params.releaseId, {
          requestId: `${params.releaseId}.production`,
          databaseUrl: "",
          phase: "production",
        });
      }

      await step.do("ready-to-deploy", async () => {
        await transitionRelease(
          this.env.OPS_DB,
          params.releaseId,
          "ready_to_deploy",
          { detail: { databaseAlreadyReleased } },
        );
      });

      const deployment = await step.waitForEvent<ReleaseDeploymentResult>(
        "wait-for-production-deployment",
        { type: RELEASE_DEPLOYMENT_EVENT, timeout: "30 minutes" },
      );
      await step.do("verify-deployment-event", async () => {
        const result = deployment.payload;
        if (
          result.releaseId !== params.releaseId ||
          result.gitSha !== params.gitSha ||
          result.appImageDigest !== params.appImageDigest
        )
          throw new Error("deployment event artifact identity mismatch");
        await transitionRelease(
          this.env.OPS_DB,
          params.releaseId,
          "verifying_deployment",
        );
        if (!result.success)
          throw new Error(result.error || "production deployment failed");
        if (
          !result.checks ||
          Object.values(result.checks).some((passed) => passed !== true)
        )
          throw new Error("production deployment checks are incomplete");
        const identity = await this.env.PRODUCTION.verifyRelease(
          params.releaseId,
        );
        if (
          !result.cloudflareVersionId ||
          identity.versionId !== result.cloudflareVersionId
        )
          throw new Error("deployed Cloudflare version identity mismatch");
        if (!identity.serverReady || !identity.workerReady)
          throw new Error("deployed application processes are not ready");
      });

      await step.do("complete-release", async () => {
        const result = deployment.payload;
        if (maintenanceEntered)
          await this.env.PRODUCTION.clearMaintenance(params.releaseId);
        if (lockAcquired)
          await releaseReleaseLock(this.env.OPS_DB, params.releaseId);
        await transitionRelease(
          this.env.OPS_DB,
          params.releaseId,
          "deployed",
          { cloudflareVersionId: result.cloudflareVersionId ?? null },
        );
      });
      return { releaseId: params.releaseId, state: "deployed" };
    } catch (error) {
      const message = sanitizedErrorMessage(error);
      try {
        await destroyReleaseAgent(this.env);
      } catch {
        // The Container may not have been created yet.
      }
      if (branch) {
        try {
          await deleteReleaseBranch(this.env, branch.branchId);
        } catch {
          // Neon expiration is the final cleanup safety net.
        }
      }
      if (maintenanceEntered && !productionMutationStarted) {
        await this.env.PRODUCTION.clearMaintenance(params.releaseId);
        if (lockAcquired)
          await releaseReleaseLock(this.env.OPS_DB, params.releaseId);
      }
      await transitionRelease(
        this.env.OPS_DB,
        params.releaseId,
        maintenanceEntered && productionMutationStarted
          ? "needs_review"
          : "failed",
        { errorMessage: message },
      );
      await this.env.STATUS_KV.put("release:last-error", message);
      throw error;
    }
  }
}
