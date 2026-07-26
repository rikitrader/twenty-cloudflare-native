"use strict";

const { CloudflareStateClient } = require("./state-client.cjs");

function sessionTtl(session, defaultTtlMs) {
  const maxAge = session?.cookie?.originalMaxAge ?? session?.cookie?.maxAge;
  return Number.isSafeInteger(maxAge) && maxAge > 0 ? maxAge : defaultTtlMs;
}

function createCloudflareSessionStore(sessionModule, options = {}) {
  const state = new CloudflareStateClient({
    namespace: "session",
    ...options,
  });
  const prefix = options.prefix ?? "engine:session:";
  const defaultTtlMs = options.ttlMs ?? 30 * 60_000;

  return new (class CloudflareSessionStore extends sessionModule.Store {
    get(sid, callback) {
      state
        .get(`${prefix}${sid}`)
        .then((result) => callback(null, result.found ? result.value : null))
        .catch((error) => callback(error));
    }

    set(sid, session, callback = () => {}) {
      state
        .set(`${prefix}${sid}`, session, sessionTtl(session, defaultTtlMs))
        .then(() => callback(null))
        .catch((error) => callback(error));
    }

    destroy(sid, callback = () => {}) {
      state
        .delete(`${prefix}${sid}`)
        .then(() => callback(null))
        .catch((error) => callback(error));
    }

    touch(sid, session, callback = () => {}) {
      state
        .expire(`${prefix}${sid}`, sessionTtl(session, defaultTtlMs))
        .then(() => callback(null))
        .catch((error) => callback(error));
    }

    clear(callback = () => {}) {
      state
        .clear()
        .then(() => callback(null))
        .catch((error) => callback(error));
    }
  })();
}

module.exports = { createCloudflareSessionStore, sessionTtl };
