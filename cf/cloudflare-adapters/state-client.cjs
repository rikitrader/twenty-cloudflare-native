"use strict";

const DEFAULT_URL = "http://twenty-state.internal";

class CloudflareStateClient {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl ?? process.env.CLOUDFLARE_STATE_URL ?? DEFAULT_URL;
    this.token = options.token ?? process.env.INTERNAL_SERVICE_TOKEN;
    this.shard =
      options.shard ?? process.env.CLOUDFLARE_STATE_SHARD ?? "workspace:default";
    this.namespace = options.namespace;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!this.token) throw new Error("INTERNAL_SERVICE_TOKEN is required");
    if (!this.namespace) throw new Error("state namespace is required");
  }

  async post(path, body = {}) {
    const response = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        "x-twenty-state-shard": this.shard,
      },
      body: JSON.stringify({ namespace: this.namespace, ...body }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(
        `Cloudflare state ${path} failed (${response.status}): ${
          result.error ?? "unknown error"
        }`,
      );
    }
    return result;
  }

  get(key) {
    return this.post("/v1/state/get", { key });
  }

  set(key, value, ttlMs) {
    return this.post("/v1/state/set", {
      key,
      value,
      ...(ttlMs ? { ttlMs } : {}),
    });
  }

  delete(key) {
    return this.post("/v1/state/delete", { key });
  }

  mget(keys) {
    return this.post("/v1/state/mget", { keys });
  }

  mdelete(keys) {
    return this.post("/v1/state/mdelete", { keys });
  }

  expire(key, ttlMs) {
    return this.post("/v1/state/expire", { key, ttlMs });
  }

  increment(key, delta) {
    return this.post("/v1/state/increment", { key, delta });
  }

  clear() {
    return this.post("/v1/state/clear");
  }

  scan(pattern, after, limit) {
    return this.post("/v1/state/scan", {
      pattern,
      limit,
      ...(after ? { after } : {}),
    });
  }

  setAdd(key, members) {
    return this.post("/v1/set/add", { key, members });
  }

  setRemove(key, members) {
    return this.post("/v1/set/remove", { key, members });
  }

  setPop(key) {
    return this.post("/v1/set/pop", { key });
  }

  setCard(key) {
    return this.post("/v1/set/card", { key });
  }

  setMembers(key) {
    return this.post("/v1/set/members", { key });
  }

  hashValues(key) {
    return this.post("/v1/hash/values", { key });
  }

  hashSet(key, field, value, options = {}) {
    return this.post("/v1/hash/set", { key, field, value, ...options });
  }

  hashDelete(key, field) {
    return this.post("/v1/hash/delete", { key, field });
  }

  listAppend(key, value) {
    return this.post("/v1/list/append", { key, value });
  }

  listRange(key) {
    return this.post("/v1/list/range", { key });
  }

  acquireLock(key, owner, ttlMs) {
    return this.post("/v1/lock/acquire", { key, owner, ttlMs });
  }

  releaseLock(key, owner) {
    return this.post("/v1/lock/release", { key, owner });
  }
}

module.exports = { CloudflareStateClient };
