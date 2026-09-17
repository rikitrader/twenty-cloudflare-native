const baseUrl = (
  process.env.OBSERVATION_URL ?? "https://twenty-crm.observatorio-publico.workers.dev"
).replace(/\/$/, "");
const response = await fetch(`${baseUrl}/_status`, {
  signal: AbortSignal.timeout(30_000),
});
const body = await response.json().catch(() => ({}));
const sample = {
  capturedAt: new Date().toISOString(),
  endpoint: `${baseUrl}/_status`,
  httpStatus: response.status,
  status: body.status,
  productionReady: body.productionReady === true,
  durableRedis: body.durableRedis === true,
  redisBackend: body.redisBackend,
  cloudflareStateReady: body.cloudflareStateReady === true,
  result:
    response.ok &&
    body.status === "ok" &&
    body.productionReady === true &&
    body.durableRedis === true &&
    body.redisBackend === "cloudflare" &&
    body.cloudflareStateReady === true
      ? "passed"
      : "failed",
};
console.log(JSON.stringify(sample, null, 2));
if (sample.result !== "passed") process.exitCode = 1;
