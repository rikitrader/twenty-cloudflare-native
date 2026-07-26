import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const PROBE_CONFIG = "wrangler.staging-probe.jsonc";
const PROBE_URL =
  "https://twenty-enterprise-staging-probe.rikitrader.workers.dev";
const R2_BUCKET = "twenty-storage-enterprise-staging";
const POSTGRES_IMAGE =
  "postgres@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15";
const EVIDENCE_PATH = "docs/evidence/g11-recovery-drill.json";
const startedAt = Date.now();
const runId = `g11-${randomBytes(10).toString("hex")}`;
const containerName = `twenty-${runId}`;
const postgresPassword = randomBytes(24).toString("base64url");
const tempDirectory = await mkdtemp(join(tmpdir(), `${runId}-`));

function command(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: options.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    if (options.input) child.stdin.end(options.input);
    child.once("error", reject);
    child.once("exit", (code) => {
      const result = {
        code,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      };
      if (code === 0 || options.allowFailure) resolve(result);
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} failed (${code}): ${result.stderr.slice(-2_000)}`,
          ),
        );
    });
  });
}

async function putProbeToken(token) {
  await command("./node_modules/.bin/wrangler", [
    "secret",
    "put",
    "PROBE_TOKEN",
    "--config",
    PROBE_CONFIG,
  ], { input: `${token}\n` });
}

async function probe(path, init = {}) {
  const response = await fetch(`${PROBE_URL}/probe`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${probeToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      path,
      method: init.method ?? "GET",
      ...(init.body === undefined ? {} : { body: init.body }),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

async function waitForProbe() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const result = await probe("/_canary/keys").catch(() => null);
    if (result?.response.ok) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("staging probe did not accept the rotated credential");
}

async function waitForWorkflow(id) {
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    const { response, body } = await probe(
      `/_canary/recovery/export?id=${encodeURIComponent(id)}`,
    );
    assert.equal(response.ok, true, JSON.stringify(body));
    const status = body.details?.status;
    if (status === "complete") return body.details.output;
    if (["errored", "terminated", "unknown"].includes(status))
      throw new Error(`backup workflow ${status}: ${JSON.stringify(body)}`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("backup workflow timed out");
}

async function waitForPostgres() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const result = await command(
      "docker",
      ["exec", containerName, "pg_isready", "-U", "postgres", "-d", "recovery"],
      { allowFailure: true },
    );
    if (result.code === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("disposable PostgreSQL did not become ready");
}

async function psql(sql, input) {
  return command(
    "docker",
    [
      "exec",
      "-i",
      containerName,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "recovery",
      ...(sql ? ["-Atc", sql] : []),
    ],
    input ? { input } : {},
  );
}

const probeToken = randomBytes(32).toString("base64url");
let exportOutput;
let manifest;
let dump;
let restoreStartedAt;
let restoreCompletedAt;
let tableCount;
let sequenceCount;
let databaseBytes;

try {
  await putProbeToken(probeToken);
  await waitForProbe();

  const trigger = await probe("/_canary/recovery/export", {
    method: "POST",
    body: {},
  });
  assert.equal(trigger.response.status, 202, JSON.stringify(trigger.body));
  assert.equal(typeof trigger.body.id, "string");
  exportOutput = await waitForWorkflow(trigger.body.id);
  assert.equal(typeof exportOutput?.key, "string");
  assert.equal(typeof exportOutput?.manifestKey, "string");

  const manifestPath = join(tempDirectory, "manifest.json");
  const dumpPath = join(tempDirectory, "backup.sql");
  await command("./node_modules/.bin/wrangler", [
    "r2",
    "object",
    "get",
    `${R2_BUCKET}/${exportOutput.manifestKey}`,
    "--file",
    manifestPath,
    "--remote",
  ]);
  await command("./node_modules/.bin/wrangler", [
    "r2",
    "object",
    "get",
    `${R2_BUCKET}/${exportOutput.key}`,
    "--file",
    dumpPath,
    "--remote",
  ]);

  manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  dump = await readFile(dumpPath);
  const downloadedSha256 = createHash("sha256").update(dump).digest("hex");
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.artifact.key, exportOutput.key);
  assert.equal(manifest.artifact.bytes, dump.length);
  assert.equal(manifest.artifact.sha256, downloadedSha256);
  assert.equal(exportOutput.sha256, downloadedSha256);

  await command("docker", [
    "run",
    "--detach",
    "--name",
    containerName,
    "--env",
    `POSTGRES_PASSWORD=${postgresPassword}`,
    "--env",
    "POSTGRES_DB=recovery",
    "--tmpfs",
    "/var/lib/postgresql:rw,noexec,nosuid,size=2g",
    POSTGRES_IMAGE,
  ]);
  await waitForPostgres();

  restoreStartedAt = Date.now();
  await psql(null, dump);
  restoreCompletedAt = Date.now();
  await psql("ANALYZE;");
  tableCount = Number(
    (
      await psql(
        `SELECT count(*) FROM information_schema.tables
         WHERE table_type='BASE TABLE'
           AND table_schema NOT IN ('pg_catalog', 'information_schema')
           AND table_schema NOT LIKE 'pg_toast%';`,
      )
    ).stdout.trim(),
  );
  sequenceCount = Number(
    (
      await psql(
        `SELECT count(*) FROM information_schema.sequences
         WHERE sequence_schema NOT IN ('pg_catalog', 'information_schema')
           AND sequence_schema NOT LIKE 'pg_toast%';`,
      )
    ).stdout.trim(),
  );
  databaseBytes = Number(
    (await psql("SELECT pg_database_size(current_database());")).stdout.trim(),
  );
  assert.ok(tableCount >= 50, `only ${tableCount} application tables restored`);
  assert.ok(databaseBytes >= dump.length);

  const completedAt = Date.now();
  const evidence = {
    gate: "G11",
    passed: true,
    environment: "enterprise-staging",
    productionTouched: false,
    runId,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(completedAt).toISOString(),
    source: {
      workflowId: trigger.body.id,
      artifactKey: exportOutput.key,
      manifestKey: exportOutput.manifestKey,
      bytes: dump.length,
      sha256: manifest.artifact.sha256,
      createdAt: manifest.createdAt,
      encryption: manifest.encryption,
    },
    recoveryTarget: {
      isolation: "disposable-local-container-with-tmpfs",
      image: POSTGRES_IMAGE,
      liveDatabaseCredentialsProvided: false,
    },
    integrity: {
      r2ManifestMatched: true,
      sha256Matched: true,
      bytesMatched: true,
    },
    validation: {
      restoreExitCode: 0,
      applicationTableCount: tableCount,
      applicationSequenceCount: sequenceCount,
      restoredDatabaseBytes: databaseBytes,
    },
    objectives: {
      rtoMs: completedAt - startedAt,
      restoreMs: restoreCompletedAt - restoreStartedAt,
      rpoMsAtDrillStart: Math.max(
        0,
        startedAt - Date.parse(manifest.createdAt),
      ),
    },
  };
  await writeFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await command("docker", ["rm", "--force", containerName], {
    allowFailure: true,
  });
  await rm(tempDirectory, { recursive: true, force: true });
}
