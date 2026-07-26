#!/usr/bin/env node
import { spawn } from "node:child_process";

const mode = process.argv[2];
const required = [
  "GITHUB_SHA",
  "APP_IMAGE_DIGEST",
  "APP_VERSION",
  "RELEASE_CONTROL_URL",
  "RELEASE_TOKEN",
];
for (const name of required)
  if (!process.env[name]) throw new Error(`${name} is required`);

const gitSha = process.env.GITHUB_SHA;
const digest = process.env.APP_IMAGE_DIGEST;
if (!/^[a-f0-9]{40}$/.test(gitSha)) throw new Error("invalid GITHUB_SHA");
if (!/^sha256:[a-f0-9]{64}$/.test(digest))
  throw new Error("invalid APP_IMAGE_DIGEST");

const releaseId =
  process.env.RELEASE_ID ||
  `release-${gitSha.slice(0, 12)}-${digest.slice("sha256:".length, 16 + "sha256:".length)}`;
const baseUrl = process.env.RELEASE_CONTROL_URL.replace(/\/$/, "");
const headers = {
  authorization: `Bearer ${process.env.RELEASE_TOKEN}`,
  "content-type": "application/json",
  ...(process.env.CF_ACCESS_CLIENT_ID
    ? { "cf-access-client-id": process.env.CF_ACCESS_CLIENT_ID }
    : {}),
  ...(process.env.CF_ACCESS_CLIENT_SECRET
    ? { "cf-access-client-secret": process.env.CF_ACCESS_CLIENT_SECRET }
    : {}),
};

async function command(args) {
  await new Promise((resolve, reject) => {
    const child = spawn("./node_modules/.bin/wrangler", args, {
      stdio: "inherit",
      env: process.env,
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`wrangler exited with ${code}`)),
    );
  });
}

async function commandJson(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("./node_modules/.bin/wrangler", args, {
      stdio: ["ignore", "pipe", "inherit"],
      env: process.env,
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0)
        return reject(new Error(`wrangler exited with ${code}`));
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("wrangler did not return JSON"));
      }
    });
  });
}

async function status() {
  const response = await fetch(`${baseUrl}/v1/releases/${releaseId}`, {
    headers,
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`release status failed: HTTP ${response.status}`);
  return response.json();
}

async function poll(target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await status();
    const state = result?.release?.state;
    process.stdout.write(`release ${releaseId}: ${state || "starting"}\n`);
    if (state === target) return result;
    if (state === "failed" || state === "needs_review")
      throw new Error(
        result.release.error_message || `release entered ${state}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  throw new Error(`timed out waiting for ${target}`);
}

async function sendDeployment(payload) {
  const response = await fetch(
    `${baseUrl}/v1/releases/${releaseId}/events`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    },
  );
  if (!response.ok)
    throw new Error(`deployment event failed: HTTP ${response.status}`);
}

const identity = {
  releaseId,
  gitSha,
  appImageDigest: digest,
};

if (mode === "prepare") {
  if (!(await status()))
    await command([
      "workflows",
      "trigger",
      "twenty-release",
      "--config",
      "wrangler.release.jsonc",
      "--id",
      releaseId,
      "--params",
      JSON.stringify({
        ...identity,
        appVersion: process.env.APP_VERSION,
      }),
    ]);
  await poll("ready_to_deploy", 45 * 60_000);
  process.stdout.write(`RELEASE_ID=${releaseId}\n`);
} else if (mode === "complete") {
  const versions = await commandJson([
    "versions",
    "list",
    "--config",
    "wrangler.jsonc",
    "--json",
  ]);
  const version = [...versions]
    .reverse()
    .find((item) => item.annotations?.["workers/tag"] === gitSha);
  if (!version) throw new Error("deployed version tag was not found");
  await sendDeployment({
    ...identity,
    success: true,
    cloudflareVersionId: version.id,
    checks: { deployment: true },
  });
  await poll("deployed", 15 * 60_000);
} else if (mode === "fail") {
  const current = await status();
  if (current?.release?.state === "ready_to_deploy")
    await sendDeployment({
      ...identity,
      success: false,
      error: process.env.RELEASE_FAILURE || "production deployment failed",
    });
} else {
  throw new Error("usage: release-control.mjs prepare|complete|fail");
}
