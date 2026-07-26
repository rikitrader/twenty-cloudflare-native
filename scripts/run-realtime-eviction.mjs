import assert from "node:assert/strict";
import { createTestHarness } from "wrangler";

const server = createTestHarness({
  workers: [
    {
      config: {
        name: "realtime-eviction-fixture",
        main: "scripts/eviction-fixture-worker.ts",
        compatibility_date: "2026-06-08",
        durable_objects: {
          bindings: [{ name: "PUBSUB_DO", class_name: "TwentyPubSub" }],
        },
        migrations: [
          { tag: "v1", new_sqlite_classes: ["TwentyPubSub"] },
        ],
        vars: { CANARY_MODE: "true", INTERNAL_SERVICE_TOKEN: "fixture" },
      },
    },
  ],
});

try {
  await server.listen();
  const worker = server.getWorker();
  const channel = "eviction-test";
  const published = await worker.fetch(`/publish?channel=${channel}`, {
    method: "POST",
  });
  assert.equal(published.status, 200);
  const before = await worker.fetch(`/replay?channel=${channel}`);
  const beforeBody = await before.json();
  assert.equal(beforeBody.events.length, 1);

  await worker.evictDurableObject("PUBSUB_DO", {
    name: "workspace:default",
    webSockets: "hibernate",
  });

  const after = await worker.fetch(`/replay?channel=${channel}`);
  const afterBody = await after.json();
  assert.equal(after.status, 200);
  assert.equal(afterBody.events.length, 1);
  assert.deepEqual(afterBody.events[0].payload, { ok: true });
  console.log(JSON.stringify({
    result: "passed",
    forcedEviction: true,
    storageRetained: true,
    eventsBefore: beforeBody.events.length,
    eventsAfter: afterBody.events.length,
  }, null, 2));
} finally {
  await server.close();
}
