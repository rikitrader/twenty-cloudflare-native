// Private one-shot database release agent for Cloudflare Containers.
// It is reachable only through the release Worker's Durable Object binding.
const http = require("http");
const { spawn } = require("child_process");

const PORT = 2023;
const CWD = "/app/packages/twenty-server";
const MAX_BODY_BYTES = 16 * 1024;
const MAX_LOG_BYTES = 48 * 1024;
const DATABASE_URL_PATTERN =
  /postgres(?:ql)?:\/\/[^\s'"]+/gi;

let active = null;

function sanitized(value) {
  return String(value || "")
    .replace(DATABASE_URL_PATTERN, "postgresql://***")
    .slice(-MAX_LOG_BYTES);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function runCommand(command, args, env, timeoutMs = 20 * 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: CWD,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk) => {
      output = sanitized(`${output}${chunk}`);
      if (active) active.log = output;
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} timed out`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) return resolve(output);
      reject(
        new Error(
          `${command} exited ${code ?? signal ?? "unknown"}: ${sanitized(output)}`,
        ),
      );
    });
  });
}

async function schemaExists(env) {
  const output = await runCommand(
    "psql",
    [
      env.PG_DATABASE_URL,
      "-tAc",
      "SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name='core')",
    ],
    env,
    60_000,
  );
  return output.trim().endsWith("t");
}

async function executeRelease(input) {
  const env = {
    ...process.env,
    PG_DATABASE_URL: input.databaseUrl,
    INTERNAL_SERVICE_TOKEN: input.runtime.internalServiceToken,
    ENCRYPTION_KEY: input.runtime.encryptionKey,
    ...(input.runtime.fallbackEncryptionKey
      ? { FALLBACK_ENCRYPTION_KEY: input.runtime.fallbackEncryptionKey }
      : {}),
    ...(input.runtime.appSecret ? { APP_SECRET: input.runtime.appSecret } : {}),
    DISABLE_DB_MIGRATIONS: "true",
    DISABLE_CRON_JOBS_REGISTRATION: "true",
  };
  const exists = await schemaExists(env);
  if (!exists) {
    if (input.allowInitialize !== true)
      throw new Error("target database has no Twenty core schema");
    await runCommand("yarn", ["database:init:prod"], env);
  }

  await runCommand("yarn", ["command:prod", "upgrade"], env);

  if (input.phase === "production") {
    await runCommand("yarn", ["command:prod", "cache:flush"], env, 5 * 60_000);
    await runCommand(
      "yarn",
      ["command:prod", "cron:register:all"],
      env,
      5 * 60_000,
    );
    await runCommand("yarn", ["command:prod", "cache:flush"], env, 5 * 60_000);
  }

  if (!(await schemaExists(env)))
    throw new Error("post-release schema verification failed");
}

function publicState() {
  if (!active) return { status: "idle" };
  return {
    requestId: active.requestId,
    phase: active.phase,
    status: active.status,
    startedAt: active.startedAt,
    completedAt: active.completedAt,
    error: active.error,
    log: active.log,
  };
}

const server = http.createServer(async (req, res) => {
  const path = new URL(req.url, "http://release-agent").pathname;
  res.setHeader("content-type", "application/json");

  if (path === "/ping") return res.end(JSON.stringify({ ok: true }));
  if (path === "/status") return res.end(JSON.stringify(publicState()));
  if (path !== "/run" || req.method !== "POST") {
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: "not found" }));
  }

  try {
    const input = await readJson(req);
    if (
      typeof input.requestId !== "string" ||
      !/^[a-zA-Z0-9._-]{8,128}$/.test(input.requestId) ||
      typeof input.databaseUrl !== "string" ||
      !input.databaseUrl.startsWith("postgres") ||
      !["preflight", "production"].includes(input.phase) ||
      typeof input.runtime?.internalServiceToken !== "string" ||
      input.runtime.internalServiceToken.length < 16 ||
      typeof input.runtime?.encryptionKey !== "string" ||
      input.runtime.encryptionKey.length < 16
    ) {
      res.statusCode = 400;
      return res.end(JSON.stringify({ error: "invalid release request" }));
    }
    if (active?.requestId === input.requestId)
      return res.end(JSON.stringify(publicState()));
    if (active?.status === "running") {
      res.statusCode = 409;
      return res.end(JSON.stringify({ error: "another release is running" }));
    }

    active = {
      requestId: input.requestId,
      phase: input.phase,
      status: "running",
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      log: "",
    };
    executeRelease(input)
      .then(() => {
        active.status = "complete";
        active.completedAt = new Date().toISOString();
      })
      .catch((error) => {
        active.status = "failed";
        active.error = sanitized(error?.message || error);
        active.completedAt = new Date().toISOString();
      });
    res.statusCode = 202;
    return res.end(JSON.stringify(publicState()));
  } catch (error) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: sanitized(error?.message || error) }));
  }
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`release agent listening on :${PORT}`),
);
