// Backup agent — tiny HTTP sidecar on :2021, reachable only through the
// Durable Object tunnel (or the token-guarded /_agent/* Worker route).
// Endpoints: /ping /state /mark-settled /dump /restore
const http = require("http");
const fs = require("fs");
const crypto = require("crypto");
const { spawn, execFile } = require("child_process");

const PORT = 2021;
const BACKUP_ONLY = process.env.BACKUP_ONLY === "true";
const MARKER = "/tmp/cf-restore-settled"; // tmpfs: resets on every boot
const PG_URL =
  process.env.PG_DATABASE_URL || "postgres://twenty:twenty@localhost:5432/default";

// Port 2021 is never exposed by a Container application. Authorization is
// enforced at the Worker route before it opens the Durable Object tunnel; the
// backup Workflow reaches this private port through its binding directly.
const authed = () => true;
const settled = () => BACKUP_ONLY || fs.existsSync(MARKER);

const dumpToFile = (res) => {
  const dumpPath = `/tmp/twenty-backup-${crypto.randomUUID()}.sql`;
  const dump = spawn("pg_dump", [
    PG_URL,
    "--no-owner",
    "--no-privileges",
    "--format=plain",
    "--file",
    dumpPath,
  ]);
  let err = "";
  dump.stderr.on("data", (data) => {
    if (err.length < 16_384) err += data;
  });
  dump.on("error", (error) => {
    fs.rm(dumpPath, { force: true }, () => {});
    if (!res.headersSent) res.statusCode = 500;
    res.end(`pg_dump failed: ${error.message.slice(0, 300)}`);
  });
  dump.on("close", (code) => {
    if (code !== 0) {
      fs.rm(dumpPath, { force: true }, () => {});
      res.statusCode = 500;
      return res.end(`pg_dump failed: ${err.slice(0, 300)}`);
    }
    fs.stat(dumpPath, (statError, stat) => {
      if (statError || stat.size < 1024) {
        fs.rm(dumpPath, { force: true }, () => {});
        res.statusCode = 500;
        return res.end(
          `pg_dump output invalid: ${statError?.message || `${stat.size} bytes`}`,
        );
      }
      const hash = crypto.createHash("sha256");
      const input = fs.createReadStream(dumpPath);
      input.on("data", (chunk) => hash.update(chunk));
      input.on("error", (error) => {
        fs.rm(dumpPath, { force: true }, () => {});
        res.statusCode = 500;
        res.end(`backup checksum failed: ${error.message.slice(0, 300)}`);
      });
      input.on("end", () => {
        const sha256 = hash.digest("hex");
        res.setHeader("content-type", "application/sql");
        res.setHeader("content-length", String(stat.size));
        res.setHeader("x-backup-sha256", sha256);
        const body = fs.createReadStream(dumpPath);
        body.on("close", () => fs.rm(dumpPath, { force: true }, () => {}));
        body.on("error", (error) => res.destroy(error));
        body.pipe(res);
      });
    });
  });
};

const server = http.createServer((req, res) => {
  const path = req.url.split("?")[0];

  if (path === "/ping") return res.end("ok");

  if (!authed(req)) {
    res.statusCode = 401;
    return res.end("unauthorized");
  }

  if (path === "/state") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ settled: settled() }));
  }

  if (path === "/mark-settled" && req.method === "POST") {
    fs.writeFileSync(MARKER, new Date().toISOString());
    return res.end("settled");
  }

  if (path === "/inspect") {
    // Read-only: dump the image's init scripts + s6 deps so we can see how
    // init-db honors DISABLE_DB_MIGRATIONS.
    execFile(
      "sh",
      [
        "-c",
        'echo "=== init-db.sh ==="; cat /etc/s6-overlay/scripts/init-db.sh 2>/dev/null; echo "=== twenty-server run ==="; cat /etc/s6-overlay/s6-rc.d/twenty-server/run 2>/dev/null; cat /etc/s6-overlay/s6-rc.d/twenty-server/up 2>/dev/null; echo "=== init-db deps ==="; ls /etc/s6-overlay/s6-rc.d/init-db/ 2>/dev/null; cat /etc/s6-overlay/s6-rc.d/twenty-server/dependencies.d/* 2>/dev/null | tr "\\n" " "; echo; echo "=== env DISABLE ==="; env | grep -iE "DISABLE|PG_DATABASE|SIGN_IN" | sed -E "s#(://[^@]+@)#://***@#"',
      ],
      { timeout: 15_000, maxBuffer: 2_000_000 },
      (e, stdout, stderr) => {
        res.setHeader("content-type", "text/plain");
        res.end(`${stdout}\n${stderr || ""}${e ? `\nERR: ${e.message}` : ""}`);
      },
    );
    return;
  }

  if (path === "/logs") {
    // Fixed diagnostic bundle: process table + s6 service logs. Read-only.
    execFile(
      "sh",
      [
        "-c",
        'ps aux | head -40; echo "=== s6 services ==="; ls /etc/s6-overlay/s6-rc.d/ 2>/dev/null | head -20; ls /run/service/ 2>/dev/null; echo "=== supervisor status ==="; for s in twenty-server twenty-worker postgres redis; do echo "--- $s"; s6-svstat "/run/service/$s" 2>&1; ls -la "/run/service/$s/supervise" 2>/dev/null | head -20; done; echo "=== logs ==="; for f in $(find /var/log -name current 2>/dev/null | head -8); do echo "--- $f"; tail -n 80 "$f"; done',
      ],
      { timeout: 20_000, maxBuffer: 4_000_000 },
      (e, stdout, stderr) => {
        res.setHeader("content-type", "text/plain");
        res.end(`${stdout}\n${stderr || ""}${e ? `\nERR: ${e.message}` : ""}`);
      },
    );
    return;
  }

  if (path === "/dump") {
    // Refuse to dump before the restore phase settles — otherwise an hourly
    // backup racing a cold boot would snapshot seed data over a good backup.
    if (!settled()) {
      res.statusCode = 503;
      return res.end("restore not settled yet");
    }
    // Materialize on the container's ephemeral disk so the Worker can stream
    // the body to R2 while R2 validates the precomputed SHA-256 checksum.
    return dumpToFile(res);
  }

  if (path === "/restore" && req.method === "POST") {
    if (BACKUP_ONLY) {
      res.statusCode = 405;
      return res.end("restore disabled on backup-only container");
    }
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      fs.writeFileSync("/tmp/restore.sql", Buffer.concat(chunks));
      execFile("/cf/restore.sh", { timeout: 300_000 }, (e, stdout, stderr) => {
        if (e) {
          // Fail-open for serving, fail-closed for dumps: marker stays absent
          // so a poisoned dump can never overwrite the last good backup.
          console.error("restore failed:", stderr || e.message);
          res.statusCode = 500;
          return res.end(`restore failed: ${(stderr || e.message).slice(0, 400)}`);
        }
        res.end(`restored ${chunks.reduce((n, c) => n + c.length, 0)} bytes`);
      });
    });
    return;
  }

  res.statusCode = 404;
  res.end("not found");
});

server.listen(PORT, () => console.log(`cf backup agent on :${PORT}`));
