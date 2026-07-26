"use strict";

const crypto = require("node:crypto");
const { CloudflareStateClient } = require("./state-client.cjs");

class CloudflareRedisCompatibilityClient {
  constructor(state) {
    this.state = state;
    this.lockOwners = new Map();
    this.scanCursors = new Map();
    this.nextCursor = 1;
  }

  async del(keys) {
    const list = Array.isArray(keys) ? keys : [keys];
    let deleted = 0;
    const regular = [];
    for (const key of list) {
      const owner = this.lockOwners.get(key);
      if (owner) {
        const result = await this.state.releaseLock(key, owner);
        this.lockOwners.delete(key);
        deleted += result.released ? 1 : 0;
      } else {
        regular.push(key);
      }
    }
    if (regular.length === 1) {
      const result = await this.state.delete(regular[0]);
      deleted += result.deleted ? 1 : 0;
    } else if (regular.length > 1) {
      deleted += (await this.state.mdelete(regular)).deleted;
    }
    return deleted;
  }

  async mGet(keys) {
    const { values } = await this.state.mget(keys);
    return values.map((value) =>
      value === null || value === undefined ? null : JSON.stringify(value),
    );
  }

  async sAdd(key, members) {
    return (await this.state.setAdd(key, members)).count;
  }

  async sRem(key, members) {
    return (await this.state.setRemove(key, members)).count;
  }

  async sPop(key, size = 1) {
    const members = [];
    for (let index = 0; index < size; index += 1) {
      const { member } = await this.state.setPop(key);
      if (member === null) break;
      members.push(member);
    }
    return members;
  }

  async sCard(key) {
    return (await this.state.setCard(key)).count;
  }

  async sMembers(key) {
    return (await this.state.setMembers(key)).members;
  }

  async expire(key, seconds) {
    return (await this.state.expire(key, seconds * 1000)).updated;
  }

  async pExpire(key, ttlMs) {
    return (await this.state.expire(key, ttlMs)).updated;
  }

  async scan(cursor, options) {
    const after = cursor === 0 ? undefined : this.scanCursors.get(cursor);
    if (cursor !== 0 && after === undefined)
      throw new Error(`unknown Cloudflare state cursor ${cursor}`);
    const result = await this.state.scan(
      options.MATCH ?? "*",
      after,
      options.COUNT ?? 100,
    );
    if (!result.nextAfter) {
      if (cursor !== 0) this.scanCursors.delete(cursor);
      return { cursor: 0, keys: result.keys };
    }
    const next = cursor === 0 ? this.nextCursor++ : cursor;
    this.scanCursors.set(next, result.nextAfter);
    return { cursor: next, keys: result.keys };
  }

  async set(key, _value, options) {
    if (!options?.NX || !options?.PX)
      throw new Error("only NX/PX lock writes are supported");
    const owner = `${process.pid}:${crypto.randomUUID()}`;
    const result = await this.state.acquireLock(key, owner, options.PX);
    if (!result.acquired) return null;
    this.lockOwners.set(key, owner);
    return "OK";
  }

  async incrBy(key, increment) {
    return (await this.state.increment(key, increment)).value;
  }

  async hVals(key) {
    return (await this.state.hashValues(key)).values;
  }

  async hSet(key, field, value) {
    return (await this.state.hashSet(key, field, value)).changed;
  }

  async hDel(key, field) {
    return (await this.state.hashDelete(key, field)).deleted ? 1 : 0;
  }

  async eval(_script, options) {
    const [key] = options.keys;
    const [field, value] = options.arguments;
    return (
      await this.state.hashSet(key, field, value, { onlyIfKeyExists: true })
    ).changed;
  }

  // cache-manager's Redis store lifecycle calls quit() during Nest teardown
  // (including one-shot migration commands). The Cloudflare client owns no
  // persistent socket, so closing it is intentionally a successful no-op.
  async quit() {
    this.lockOwners.clear();
    this.scanCursors.clear();
    return "OK";
  }

  multi() {
    const operations = [];
    const pipeline = {
      sCard: (key) => {
        operations.push({ type: "sCard", key });
        return pipeline;
      },
      hSet: (key, field, value) => {
        operations.push({ type: "hSet", key, field, value });
        return pipeline;
      },
      pExpire: (key, ttlMs) => {
        operations.push({ type: "pExpire", key, ttlMs });
        return pipeline;
      },
      exec: async () => {
        if (
          operations.length === 2 &&
          operations[0].type === "hSet" &&
          operations[1].type === "pExpire" &&
          operations[0].key === operations[1].key
        ) {
          const operation = operations[0];
          const result = await this.state.hashSet(
            operation.key,
            operation.field,
            operation.value,
            { ttlMs: operations[1].ttlMs },
          );
          return [result.changed, true];
        }
        return Promise.all(
          operations.map((operation) => {
            if (operation.type === "sCard") return this.sCard(operation.key);
            if (operation.type === "hSet")
              return this.hSet(
                operation.key,
                operation.field,
                operation.value,
              );
            return this.pExpire(operation.key, operation.ttlMs);
          }),
        );
      },
    };
    return pipeline;
  }
}

function createCloudflareCacheStore(options = {}) {
  const state = new CloudflareStateClient({
    namespace: "cache",
    ...options,
  });
  const client = new CloudflareRedisCompatibilityClient(state);
  const defaultTtl = options.ttl;
  return {
    name: "redis",
    client,
    get: async (key) => {
      const result = await state.get(key);
      return result.found ? result.value : undefined;
    },
    set: async (key, value, ttl) => {
      await state.set(key, value, ttl ?? defaultTtl);
    },
    del: (key) => client.del(key),
    reset: async () => {
      await state.clear();
    },
  };
}

module.exports = {
  CloudflareRedisCompatibilityClient,
  createCloudflareCacheStore,
};
