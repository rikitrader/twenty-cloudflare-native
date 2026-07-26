export interface NeonReleaseEnv {
  NEON_API_KEY: string;
  NEON_PROJECT_ID: string;
  NEON_PARENT_BRANCH_ID: string;
  NEON_DATABASE_NAME: string;
  NEON_ROLE_NAME: string;
}

export interface NeonBranchTarget {
  branchId: string;
  databaseUrl: string;
}

const API = "https://console.neon.tech/api/v2";

class NeonApiError extends Error {
  constructor(readonly status: number) {
    super(`Neon API ${status}`);
  }
}

async function neonFetch<T>(
  env: NeonReleaseEnv,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: "application/json",
      authorization: `Bearer ${env.NEON_API_KEY}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) throw new NeonApiError(response.status);
  return response.json<T>();
}

async function findBranchByName(
  env: NeonReleaseEnv,
  name: string,
): Promise<string | null> {
  const result = await neonFetch<{
    branches?: Array<{ id: string; name: string }>;
  }>(env, `/projects/${encodeURIComponent(env.NEON_PROJECT_ID)}/branches`);
  return result.branches?.find((branch) => branch.name === name)?.id ?? null;
}

export async function createReleaseBranch(
  env: NeonReleaseEnv,
  releaseId: string,
): Promise<NeonBranchTarget> {
  const name = `twenty-release-${releaseId}`.slice(0, 63);
  let branchId = await findBranchByName(env, name);
  if (!branchId) {
    const expiresAt = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
    const create = (includeSuspendTimeout: boolean) =>
      neonFetch<{ branch: { id: string } }>(
        env,
        `/projects/${encodeURIComponent(env.NEON_PROJECT_ID)}/branches`,
        {
          method: "POST",
          body: JSON.stringify({
            branch: {
              name,
              parent_id: env.NEON_PARENT_BRANCH_ID,
              expires_at: expiresAt,
            },
            endpoints: [
              {
                type: "read_write",
                autoscaling_limit_min_cu: 0.25,
                autoscaling_limit_max_cu: 0.25,
                ...(includeSuspendTimeout
                  ? { suspend_timeout_seconds: 60 }
                  : {}),
              },
            ],
          }),
        },
      );

    let created: { branch: { id: string } };
    try {
      created = await create(true);
    } catch (error) {
      // Some Neon plans reject custom suspend intervals. The 0.25 CU cap,
      // immediate workflow cleanup, and provider-enforced two-hour expiry
      // still bound the cost of the temporary preflight branch.
      if (!(error instanceof NeonApiError) || error.status !== 412) throw error;
      created = await create(false);
    }
    branchId = created.branch.id;
  }

  const query = new URLSearchParams({
    branch_id: branchId,
    database_name: env.NEON_DATABASE_NAME,
    role_name: env.NEON_ROLE_NAME,
    pooled: "false",
  });
  const connection = await neonFetch<{ uri: string }>(
    env,
    `/projects/${encodeURIComponent(env.NEON_PROJECT_ID)}/connection_uri?${query}`,
  );
  return { branchId, databaseUrl: connection.uri };
}

export async function deleteReleaseBranch(
  env: NeonReleaseEnv,
  branchId: string,
): Promise<void> {
  const response = await fetch(
    `${API}/projects/${encodeURIComponent(env.NEON_PROJECT_ID)}/branches/${encodeURIComponent(branchId)}`,
    {
      method: "DELETE",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${env.NEON_API_KEY}`,
      },
    },
  );
  if (!response.ok && response.status !== 404)
    throw new Error(`Neon branch cleanup failed: ${response.status}`);
}
