"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CACHE_RELATIVE =
  "engine/core-modules/cache-storage/cache-storage.module-factory.js";
const SESSION_RELATIVE =
  "engine/core-modules/session-storage/session-storage.module-factory.js";
const QUEUE_FACTORY_RELATIVE =
  "engine/core-modules/message-queue/message-queue.module-factory.js";
const QUEUE_CORE_RELATIVE =
  "engine/core-modules/message-queue/message-queue-core.module.js";
const REDIS_CLIENT_RELATIVE =
  "engine/core-modules/redis-client/redis-client.service.js";
const WORKER_HEALTH_RELATIVE =
  "engine/core-modules/admin-panel/indicators/worker.health.js";
const ADMIN_HEALTH_RELATIVE =
  "engine/core-modules/admin-panel/admin-panel-health.service.js";
const ADMIN_QUEUE_RELATIVE =
  "engine/core-modules/admin-panel/admin-panel-queue.service.js";

function replaceOnce(source, expected, replacement, label) {
  const first = source.indexOf(expected);
  if (first === -1) throw new Error(`${label}: expected anchor not found`);
  if (source.indexOf(expected, first + expected.length) !== -1)
    throw new Error(`${label}: expected anchor is not unique`);
  return source.slice(0, first) + replacement + source.slice(first + expected.length);
}

function patchCacheFactory(source) {
  if (source.includes("createCloudflareCacheStore"))
    throw new Error("cache factory is already patched");
  let patched = replaceOnce(
    source,
    'const _redis = require("redis");',
    'const _redis = require("redis");\n' +
      'const { createCloudflareCacheStore } = require("/cf/cloudflare-adapters/cache-store.cjs");',
    "cache factory import",
  );
  patched = replaceOnce(
    patched,
    "    switch(cacheStorageType){",
    `    if (process.env.REDIS_BACKEND === 'cloudflare') {
        cacheStorageLogger.log('Using Cloudflare Durable Object cache storage');
        return {
            ...cacheModuleOptions,
            store: async ()=>createCloudflareCacheStore({
                    ttl: cacheStorageTtl * 1000
                })
        };
    }
    switch(cacheStorageType){`,
    "cache factory activation",
  );
  return patched;
}

function patchSessionFactory(source) {
  if (source.includes("createCloudflareSessionStore"))
    throw new Error("session factory is already patched");
  let patched = replaceOnce(
    source,
    'const _redis = require("redis");',
    'const _redis = require("redis");\n' +
      'const { createCloudflareSessionStore } = require("/cf/cloudflare-adapters/session-store.cjs");',
    "session factory import",
  );
  patched = replaceOnce(
    patched,
    "    switch(cacheStorageType){",
    `    if (process.env.REDIS_BACKEND === 'cloudflare') {
        sessionStorageLogger.log('Using Cloudflare Durable Object session storage');
        return {
            ...sessionStorage,
            store: createCloudflareSessionStore(require('express-session'), {
                prefix: 'engine:session:',
                ttlMs: 1000 * 60 * 30
            })
        };
    }
    switch(cacheStorageType){`,
    "session factory activation",
  );
  return patched;
}

function patchQueueFactory(source) {
  if (source.includes("type: 'cloudflare'"))
    throw new Error("queue factory is already patched");
  return replaceOnce(
    source,
    "    const driverType = _interfaces.MessageQueueDriverType.BullMQ;",
    `    if (process.env.REDIS_BACKEND === 'cloudflare') {
        return {
            type: 'cloudflare',
            metricsService,
            twentyConfigService
        };
    }
    const driverType = _interfaces.MessageQueueDriverType.BullMQ;`,
    "queue factory activation",
  );
}

function patchQueueCore(source) {
  if (source.includes("CloudflareQueueDriver"))
    throw new Error("queue core is already patched");
  let patched = replaceOnce(
    source,
    'const _syncdriver = require("./drivers/sync.driver");',
    'const _syncdriver = require("./drivers/sync.driver");\n' +
      'const { CloudflareQueueDriver } = require("/cf/cloudflare-adapters/queue-driver.cjs");\n' +
      'const { RollbackQueueDriver } = require("/cf/cloudflare-adapters/rollback-queue-driver.cjs");',
    "queue core import",
  );
  patched = replaceOnce(
    patched,
    "    static async createDriver(config) {\n        switch(config.type){",
    `    static async createDriver(config) {
        if (config.type === 'cloudflare') {
            return new CloudflareQueueDriver();
        }
        switch(config.type){`,
    "queue core driver",
  );
  patched = replaceOnce(
    patched,
    "                    return new _bullmqdriver.BullMQDriver(config.options, config.metricsService, config.twentyConfigService);",
    `                    const primary = new _bullmqdriver.BullMQDriver(config.options, config.metricsService, config.twentyConfigService);
                    return process.env.CLOUDFLARE_QUEUE_DRAIN === 'true'
                        ? new RollbackQueueDriver(primary)
                        : primary;`,
    "queue core rollback drain",
  );
  return patched;
}

function patchRedisClientService(source) {
  if (source.includes("CloudflareRedisFacade"))
    throw new Error("Redis client service is already patched");
  let patched = replaceOnce(
    source,
    'const _utils = require("twenty-shared/utils");',
    'const _utils = require("twenty-shared/utils");\n' +
      'const { CloudflarePubSub, CloudflareRedisFacade } = require("/cf/cloudflare-adapters/redis-compat.cjs");',
    "Redis service facade import",
  );
  patched = replaceOnce(
    patched,
    "    getQueueClient() {\n        if (!this.redisQueueClient) {",
    `    getQueueClient() {
        if (process.env.REDIS_BACKEND === 'cloudflare') {
            this.redisQueueClient ??= new CloudflareRedisFacade();
            return this.redisQueueClient;
        }
        if (!this.redisQueueClient) {`,
    "Redis queue facade",
  );
  patched = replaceOnce(
    patched,
    "    getClient() {\n        if (!this.redisClient) {",
    `    getClient() {
        if (process.env.REDIS_BACKEND === 'cloudflare') {
            this.redisClient ??= new CloudflareRedisFacade();
            return this.redisClient;
        }
        if (!this.redisClient) {`,
    "Redis direct facade",
  );
  patched = replaceOnce(
    patched,
    "    getPubSubClient() {\n        if (!this.redisPubSubClient) {",
    `    getPubSubClient() {
        if (process.env.REDIS_BACKEND === 'cloudflare') {
            this.redisPubSubClient ??= new CloudflarePubSub();
            return this.redisPubSubClient;
        }
        if (!this.redisPubSubClient) {`,
    "Redis pubsub facade",
  );
  return patched;
}

function patchCloudflareAdmin(source, kind) {
  if (source.includes("Cloudflare native queue"))
    throw new Error(`${kind} is already patched`);
  if (kind === "worker-health")
    return replaceOnce(
      source,
      "    async getQueueDetails(queueName, options) {",
      `    async getQueueDetails(queueName, options) {
        if (process.env.REDIS_BACKEND === 'cloudflare') {
            return {
                queueName,
                workers: 1,
                status: 'up',
                metrics: {
                    failed: 0, completed: 0, waiting: 0, active: 0,
                    delayed: 0, failureRate: 0,
                    ...(options?.pointsNeeded ? {
                        failedData: Array(options.pointsNeeded).fill(0),
                        completedData: Array(options.pointsNeeded).fill(0)
                    } : {})
                },
                backend: 'Cloudflare native queue'
            };
        }`,
      "worker health Cloudflare branch",
    );
  if (kind === "admin-health")
    return replaceOnce(
      source,
      "    async getQueueMetrics(queueName, timeRange = _queuemetricstimerangeenum.QueueMetricsTimeRange.OneDay) {",
      `    async getQueueMetrics(queueName, timeRange = _queuemetricstimerangeenum.QueueMetricsTimeRange.OneDay) {
        if (process.env.REDIS_BACKEND === 'cloudflare') {
            const { pointsNeeded, samplingFactor } = this.getPointsConfiguration(timeRange);
            const queueDetails = await this.workerHealth.getQueueDetails(queueName, { pointsNeeded });
            return this.transformMetricsForGraph(
                this.extractMetricsData(undefined, pointsNeeded, samplingFactor),
                this.extractMetricsData(undefined, pointsNeeded, samplingFactor),
                timeRange,
                queueName,
                queueDetails
            );
        }`,
      "admin health Cloudflare branch",
    );
  let patched = replaceOnce(
    source,
    "    async getQueueJobs(queueName, state, limit = 50, offset = 0) {",
    `    async getQueueJobs(queueName, state, limit = 50, offset = 0) {
        if (process.env.REDIS_BACKEND === 'cloudflare') {
            return {
                jobs: [], count: 0, totalCount: 0, hasMore: false,
                retentionConfig: { ..._queueretentionconstants.QUEUE_RETENTION },
                backend: 'Cloudflare native queue'
            };
        }`,
    "admin queue listing branch",
  );
  patched = replaceOnce(
    patched,
    "    async retryJobs(queueName, jobIds) {",
    `    async retryJobs(queueName, jobIds) {
        if (process.env.REDIS_BACKEND === 'cloudflare') {
            return {
                retriedCount: 0,
                results: jobIds.map((jobId)=>({
                    jobId, success: false,
                    error: 'Cloudflare native queue DLQ replay is managed outside BullMQ'
                }))
            };
        }`,
    "admin queue retry branch",
  );
  return replaceOnce(
    patched,
    "    async deleteJobs(queueName, jobIds) {",
    `    async deleteJobs(queueName, jobIds) {
        if (process.env.REDIS_BACKEND === 'cloudflare') {
            return {
                deletedCount: 0,
                results: jobIds.map((jobId)=>({
                    jobId, success: false,
                    error: 'Cloudflare native queue messages are not BullMQ jobs'
                }))
            };
        }`,
    "admin queue delete branch",
  );
}

function patchFile(filePath, patcher) {
  const source = fs.readFileSync(filePath, "utf8");
  const patched = patcher(source);
  fs.writeFileSync(filePath, patched, "utf8");
}

function patchDirectory(rootDirectory) {
  const cachePath = path.join(rootDirectory, CACHE_RELATIVE);
  const sessionPath = path.join(rootDirectory, SESSION_RELATIVE);
  const queueFactoryPath = path.join(rootDirectory, QUEUE_FACTORY_RELATIVE);
  const queueCorePath = path.join(rootDirectory, QUEUE_CORE_RELATIVE);
  const redisClientPath = path.join(rootDirectory, REDIS_CLIENT_RELATIVE);
  const workerHealthPath = path.join(rootDirectory, WORKER_HEALTH_RELATIVE);
  const adminHealthPath = path.join(rootDirectory, ADMIN_HEALTH_RELATIVE);
  const adminQueuePath = path.join(rootDirectory, ADMIN_QUEUE_RELATIVE);
  for (const target of [
    cachePath,
    sessionPath,
    queueFactoryPath,
    queueCorePath,
    redisClientPath,
    workerHealthPath,
    adminHealthPath,
    adminQueuePath,
  ]) {
    if (!fs.existsSync(target)) throw new Error(`compiled factory not found: ${target}`);
  }
  patchFile(cachePath, patchCacheFactory);
  patchFile(sessionPath, patchSessionFactory);
  patchFile(queueFactoryPath, patchQueueFactory);
  patchFile(queueCorePath, patchQueueCore);
  patchFile(redisClientPath, patchRedisClientService);
  patchFile(workerHealthPath, (source) =>
    patchCloudflareAdmin(source, "worker-health"),
  );
  patchFile(adminHealthPath, (source) =>
    patchCloudflareAdmin(source, "admin-health"),
  );
  patchFile(adminQueuePath, (source) =>
    patchCloudflareAdmin(source, "admin-queue"),
  );
  return [
    cachePath,
    sessionPath,
    queueFactoryPath,
    queueCorePath,
    redisClientPath,
    workerHealthPath,
    adminHealthPath,
    adminQueuePath,
  ];
}

function selfTest() {
  const cache = patchCacheFactory(
    'const _redis = require("redis");\nfunction x(){\n    switch(cacheStorageType){\n}',
  );
  const session = patchSessionFactory(
    'const _redis = require("redis");\nfunction x(){\n    switch(cacheStorageType){\n}',
  );
  const queueFactory = patchQueueFactory(
    "function x(){\n    const driverType = _interfaces.MessageQueueDriverType.BullMQ;\n}",
  );
  const queueCore = patchQueueCore(
    'const _syncdriver = require("./drivers/sync.driver");\n' +
      "class X {\n    static async createDriver(config) {\n        switch(config.type){\n" +
      "                    return new _bullmqdriver.BullMQDriver(config.options, config.metricsService, config.twentyConfigService);\n" +
      "}}\n",
  );
  const redisService = patchRedisClientService(
    'const _utils = require("twenty-shared/utils");\n' +
      "class X {\n" +
      "    getQueueClient() {\n        if (!this.redisQueueClient) {\n}}\n" +
      "    getClient() {\n        if (!this.redisClient) {\n}}\n" +
      "    getPubSubClient() {\n        if (!this.redisPubSubClient) {\n}}\n",
  );
  if (
    !cache.includes("createCloudflareCacheStore") ||
    !session.includes("createCloudflareSessionStore") ||
    !cache.includes("REDIS_BACKEND === 'cloudflare'") ||
    !session.includes("REDIS_BACKEND === 'cloudflare'") ||
    !queueFactory.includes("type: 'cloudflare'") ||
    !queueCore.includes("CloudflareQueueDriver") ||
    !queueCore.includes("RollbackQueueDriver") ||
    !redisService.includes("CloudflareRedisFacade") ||
    !redisService.includes("CloudflarePubSub")
  )
    throw new Error("Cloudflare adapter patch self-test failed");
}

if (require.main === module) {
  if (process.argv[2] === "--self-test") {
    selfTest();
    process.stdout.write("Cloudflare state adapter patch self-test passed\n");
  } else {
    const rootDirectory =
      process.argv[2] ?? "/app/packages/twenty-server/dist";
    const targets = patchDirectory(rootDirectory);
    process.stdout.write(`patched Cloudflare state adapters:\n${targets.join("\n")}\n`);
  }
}

module.exports = {
  patchCacheFactory,
  patchDirectory,
  patchSessionFactory,
  patchQueueFactory,
  patchQueueCore,
  patchRedisClientService,
  patchCloudflareAdmin,
  selfTest,
};
