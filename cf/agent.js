// Backup agent — tiny HTTP sidecar on :2021, reachable only through the
// Durable Object tunnel (or the token-guarded /_agent/* Worker route).
// Endpoints: /ping /state /mark-settled /dump /restore
const http = require("http");
const fs = require("fs");
const { spawn, execFile } = require("child_process");

const PORT = 2021;
const TOKEN = process.env.BACKUP_TOKEN || "";
const MARKER = "/tmp/cf-restore-settled"; // tmpfs: resets on every boot
const PG_URL =
  process.env.PG_DATABASE_URL || "postgres://twenty:twenty@localhost:5432/default";

const authed = (req) =>
  TOKEN !== "" && req.headers.authorization === `Bearer ${TOKEN}`;
const settled = () => fs.existsSync(MARKER);

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
        'ps aux | head -40; echo "=== s6 services ==="; ls /etc/s6-overlay/s6-rc.d/ 2>/dev/null | head -20; ls /run/service/ 2>/dev/null; echo "=== logs ==="; for f in $(find /var/log -name current 2>/dev/null | head -8); do echo "--- $f"; tail -n 80 "$f"; done',
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
    // Provider grants (for example Neon's cloud_admin/neon_superuser roles)
    // are not application data and make restores to plain PostgreSQL fail.
    const dump = spawn("pg_dump", [
      PG_URL,
      "--no-owner",
      "--no-privileges",
    ]);
    res.setHeader("content-type", "application/sql");
    dump.stdout.pipe(res);
    let err = "";
    dump.stderr.on("data", (d) => (err += d));
    dump.on("close", (code) => {
      if (code !== 0) {
        console.error("pg_dump failed:", code, err);
        res.destroy(new Error(`pg_dump exit ${code}`));
      }
    });
    return;
  }

  if (path === "/restore" && req.method === "POST") {
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
