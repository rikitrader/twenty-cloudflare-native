import { bearerAuthorized } from "../lib";
import {
  RELEASE_DEPLOYMENT_EVENT,
  type ReleaseDeploymentResult,
} from "../release-contracts";
import { getRelease } from "./ledger";
import type { ReleaseEnv } from "./types";

export { ContainerProxy } from "../container-compat";
export { TwentyReleaseContainer } from "./container";
export { TwentyReleaseWorkflow } from "./workflow";

function releaseIdFromPath(pathname: string): string | null {
  const match = pathname.match(
    /^\/v1\/releases\/([a-zA-Z0-9._-]{8,100})(?:\/events)?$/,
  );
  return match?.[1] ?? null;
}

export default {
  async fetch(request: Request, env: ReleaseEnv): Promise<Response> {
    if (
      !bearerAuthorized(
        request.headers.get("authorization"),
        env.RELEASE_TOKEN,
      )
    )
      return Response.json({ error: "unauthorized" }, { status: 401 });

    const url = new URL(request.url);
    const releaseId = releaseIdFromPath(url.pathname);
    if (!releaseId)
      return Response.json({ error: "not found" }, { status: 404 });

    const record = await getRelease(env.OPS_DB, releaseId);
    if (!record)
      return Response.json({ error: "release not found" }, { status: 404 });

    if (
      request.method === "GET" &&
      url.pathname === `/v1/releases/${releaseId}`
    ) {
      const workflow = await (await env.RELEASE_WF.get(releaseId)).status();
      return Response.json({
        release: record,
        workflow: {
          status: workflow.status,
          error: workflow.error,
        },
      });
    }

    if (
      request.method === "POST" &&
      url.pathname === `/v1/releases/${releaseId}/events`
    ) {
      let payload: ReleaseDeploymentResult;
      try {
        payload = await request.json<ReleaseDeploymentResult>();
      } catch {
        return Response.json({ error: "invalid JSON" }, { status: 400 });
      }
      if (
        payload.releaseId !== releaseId ||
        payload.gitSha !== record.git_sha ||
        payload.appImageDigest !== record.app_image_digest ||
        typeof payload.success !== "boolean"
      )
        return Response.json(
          { error: "deployment artifact identity mismatch" },
          { status: 409 },
        );
      await (await env.RELEASE_WF.get(releaseId)).sendEvent({
        type: RELEASE_DEPLOYMENT_EVENT,
        payload,
      });
      return Response.json({ accepted: true }, { status: 202 });
    }

    return Response.json({ error: "method not allowed" }, { status: 405 });
  },
} satisfies ExportedHandler<ReleaseEnv>;
