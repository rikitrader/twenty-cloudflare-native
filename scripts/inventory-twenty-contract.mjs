import { createHash } from "node:crypto";
import {
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

const PINNED_IMAGE =
  "twentycrm/twenty@sha256:d3dd949725e6196c57dab66ebe83ba9cdd2561885c35f94ef20f9ae38cd6d333";
const PATCH_TARGETS = [
  "engine/core-modules/cache-storage/cache-storage.module-factory.js",
  "engine/core-modules/session-storage/session-storage.module-factory.js",
  "engine/core-modules/message-queue/message-queue.module-factory.js",
  "engine/core-modules/message-queue/message-queue-core.module.js",
  "engine/core-modules/redis-client/redis-client.service.js",
  "engine/core-modules/admin-panel/indicators/worker.health.js",
  "engine/core-modules/admin-panel/admin-panel-health.service.js",
  "engine/core-modules/admin-panel/admin-panel-queue.service.js",
];
const ADAPTER_METHODS = {
  direct: [
    "del",
    "duplicate",
    "exists",
    "expire",
    "info",
    "lrange",
    "publish",
    "quit",
    "rpush",
    "set",
  ],
  pubsub: ["asyncIterator", "close", "publish"],
  subscriber: ["on", "quit", "subscribe", "unsubscribe"],
  cacheClient: [
    "del",
    "eval",
    "expire",
    "hDel",
    "hSet",
    "hVals",
    "incrBy",
    "mGet",
    "multi",
    "pExpire",
    "quit",
    "sAdd",
    "sCard",
    "sMembers",
    "sPop",
    "sRem",
    "scan",
    "set",
  ],
  cachePipeline: ["exec", "hSet", "pExpire", "sCard"],
  queueDriver: [
    "add",
    "addCron",
    "onModuleDestroy",
    "register",
    "removeCron",
    "work",
  ],
};

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
}

const root = resolve(option("--root", "/app/packages/twenty-server/dist"));
const packageRoot = resolve(option("--package-root", "/app"));
const output = option("--output");
const check = option("--check");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function relativePath(path) {
  return relative(root, path).split(sep).join("/");
}

function lineNumber(source, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor++) {
    if (source.charCodeAt(cursor) === 10) line++;
  }
  return line;
}

function lineSnippet(source, index) {
  const start = source.lastIndexOf("\n", index) + 1;
  const end = source.indexOf("\n", index);
  return source
    .slice(start, end === -1 ? source.length : end)
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function occurrences(source, regex, mapper) {
  const results = [];
  for (const match of source.matchAll(regex)) {
    results.push({
      line: lineNumber(source, match.index),
      snippet: lineSnippet(source, match.index),
      ...mapper(match),
    });
  }
  return results;
}

async function walk(directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await walk(path)));
    else if (entry.isFile() && entry.name.endsWith(".js")) paths.push(path);
  }
  return paths;
}

async function dependencyVersion(name) {
  const candidates = [
    resolve(packageRoot, "node_modules", name, "package.json"),
    resolve(packageRoot, "packages/twenty-server/node_modules", name, "package.json"),
  ];
  for (const candidate of candidates) {
    try {
      return JSON.parse(await readFile(candidate, "utf8")).version;
    } catch {
      // Try the next deterministic package location.
    }
  }
  throw new Error(`cannot locate ${name} package.json under ${packageRoot}`);
}

function runtimeFile(path) {
  return (
    (path.startsWith("engine/") || path.startsWith("modules/")) &&
    !path.includes("/__tests__/") &&
    !path.endsWith(".spec.js") &&
    !path.endsWith(".test.js")
  );
}

const rootStat = await stat(root).catch(() => null);
if (!rootStat?.isDirectory()) throw new Error(`Twenty dist root not found: ${root}`);

const files = (await walk(root)).sort();
const relevant = [];
const redisCalls = [];
const cacheClientCalls = [];
const cachePipelineCalls = [];
const subscriberCalls = [];
const queueAdds = [];
const scheduleCalls = [];
const processors = [];
const processMethods = [];
const dependencyImports = [];

for (const path of files) {
  const file = relativePath(path);
  if (!runtimeFile(file)) continue;
  const source = await readFile(path, "utf8");
  let matched = false;

  const directCalls = occurrences(
    source,
    /\b(?:this\.)?redis[A-Za-z_$][\w$]*\.get(Queue|PubSub)?Client\(\)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g,
    (match) => ({
      accessor:
        match[1] === "Queue"
          ? "queue"
          : match[1] === "PubSub"
            ? "pubsub"
            : "direct",
      method: match[2],
    }),
  );
  for (const call of directCalls) redisCalls.push({ file, ...call });
  matched ||= directCalls.length > 0;

  const localClients = [
    ...source.matchAll(
      /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\b(?:this\.)?redis[A-Za-z_$][\w$]*\.get(Queue|PubSub)?Client\(\)\s*;?/g,
    ),
  ];
  for (const client of localClients) {
    const variable = client[1];
    const accessor =
      client[2] === "Queue"
        ? "queue"
        : client[2] === "PubSub"
          ? "pubsub"
          : "direct";
    const methodPattern = new RegExp(
      `\\b${variable.replace(/[$]/g, "\\$&")}\\.([A-Za-z_$][\\w$]*)\\s*\\(`,
      "g",
    );
    const calls = occurrences(source, methodPattern, (match) => ({
      accessor,
      method: match[1],
    }));
    for (const call of calls) redisCalls.push({ file, ...call });
    matched ||= calls.length > 0;
  }

  const optimizedCacheCalls = occurrences(
    source,
    /\.store\.client\.([A-Za-z_$][\w$]*)\s*\(/g,
    (match) => ({ method: match[1] }),
  );
  for (const call of optimizedCacheCalls)
    cacheClientCalls.push({ file, ...call });
  matched ||= optimizedCacheCalls.length > 0;

  const localCacheClients = [
    ...source.matchAll(
      /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*this\.cache\.store\.client\s*;?/g,
    ),
  ];
  for (const client of localCacheClients) {
    const variable = client[1];
    const methodPattern = new RegExp(
      `\\b${variable.replace(/[$]/g, "\\$&")}\\.([A-Za-z_$][\\w$]*)\\s*\\(`,
      "g",
    );
    const calls = occurrences(source, methodPattern, (match) => ({
      method: match[1],
    }));
    for (const call of calls) cacheClientCalls.push({ file, ...call });
    matched ||= calls.length > 0;

    const pipelinePattern = new RegExp(
      `\\b${variable.replace(/[$]/g, "\\$&")}\\.multi\\(\\)([^;\\n]*)`,
      "g",
    );
    for (const pipeline of source.matchAll(pipelinePattern)) {
      for (const method of pipeline[1].matchAll(/\.([A-Za-z_$][\w$]*)\s*\(/g)) {
        cachePipelineCalls.push({
          file,
          line: lineNumber(source, pipeline.index),
          snippet: lineSnippet(source, pipeline.index),
          method: method[1],
        });
      }
    }

    const localPipelines = [
      ...source.matchAll(
        new RegExp(
          `(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${variable.replace(/[$]/g, "\\$&")}\\.multi\\(\\)`,
          "g",
        ),
      ),
    ];
    for (const localPipeline of localPipelines) {
      const pipelineVariable = localPipeline[1];
      const pipelineMethodPattern = new RegExp(
        `\\b${pipelineVariable.replace(/[$]/g, "\\$&")}\\.([A-Za-z_$][\\w$]*)\\s*\\(`,
        "g",
      );
      const calls = occurrences(source, pipelineMethodPattern, (match) => ({
        method: match[1],
      }));
      for (const call of calls) cachePipelineCalls.push({ file, ...call });
      matched ||= calls.length > 0;
    }
  }

  const subscriberProperties = [
    ...source.matchAll(
      /this\.([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\b(?:this\.)?redis[A-Za-z_$][\w$]*\.getClient\(\)\.duplicate\(\)/g,
    ),
  ];
  for (const property of subscriberProperties) {
    const methodPattern = new RegExp(
      `this\\.${property[1].replace(/[$]/g, "\\$&")}(?:\\?\\.)?\\.?(?:[\\s]*)?([A-Za-z_$][\\w$]*)\\s*\\(`,
      "g",
    );
    const calls = occurrences(source, methodPattern, (match) => ({
      method: match[1],
    }));
    for (const call of calls) subscriberCalls.push({ file, ...call });
    matched ||= calls.length > 0;
  }
  const subscriberFactoryCalls = occurrences(
    source,
    /\bensureSubscriber\(\)\.([A-Za-z_$][\w$]*)\s*\(/g,
    (match) => ({ method: match[1] }),
  );
  for (const call of subscriberFactoryCalls)
    subscriberCalls.push({ file, ...call });
  matched ||= subscriberFactoryCalls.length > 0;

  if (file.endsWith("/redis-client.service.js")) {
    const lifecycleCalls = occurrences(
      source,
      /this\.redis(Queue|PubSub)?Client\.([A-Za-z_$][\w$]*)\s*\(/g,
      (match) => ({
        accessor:
          match[1] === "Queue"
            ? "queue"
            : match[1] === "PubSub"
              ? "pubsub"
              : "direct",
        method: match[2],
      }),
    );
    for (const call of lifecycleCalls) redisCalls.push({ file, ...call });
    matched ||= lifecycleCalls.length > 0;
  }

  const adds = occurrences(
    source,
    /\.messageQueueService\.add\s*\(|\bmessageQueueService\.add\s*\(/g,
    () => ({}),
  );
  for (const call of adds) queueAdds.push({ file, ...call });
  matched ||= adds.length > 0;

  const schedules = occurrences(
    source,
    /\.(addCron|removeCron)\s*\(/g,
    (match) => ({ method: match[1] }),
  ).filter(({ snippet }) => /messageQueue|queue/i.test(snippet));
  for (const call of schedules) scheduleCalls.push({ file, ...call });
  matched ||= schedules.length > 0;

  const processorDecorators = occurrences(
    source,
    /\(0,\s*_[\w$]*processordecorator\.Processor\)\s*\(([\s\S]{0,500}?)\)\s*,/g,
    (match) => ({
      expression: match[1].replace(/\s+/g, " ").trim().slice(0, 500),
    }),
  );
  for (const call of processorDecorators) processors.push({ file, ...call });
  matched ||= processorDecorators.length > 0;

  const processDecorators = occurrences(
    source,
    /\(0,\s*_[\w$]*processdecorator\.Process\)\s*\(([^)\n]+)\)/g,
    (match) => ({ expression: match[1].trim() }),
  );
  for (const call of processDecorators) processMethods.push({ file, ...call });
  matched ||= processDecorators.length > 0;

  const imports = occurrences(
    source,
    /require\("(bullmq|ioredis|redis|connect-redis)"\)/g,
    (match) => ({ package: match[1] }),
  );
  for (const call of imports) dependencyImports.push({ file, ...call });
  matched ||= imports.length > 0;

  if (matched) relevant.push({ file, sha256: sha256(source) });
}

const patchTargets = [];
for (const file of PATCH_TARGETS) {
  const source = await readFile(resolve(root, file), "utf8");
  patchTargets.push({ file, sha256: sha256(source) });
}

function uncovered(discovered, supported, selector) {
  const allowed = new Set(supported);
  return [...new Set(discovered.map(selector).filter((method) => !allowed.has(method)))].sort();
}

function sortedUniqueCalls(calls) {
  const seen = new Set();
  return calls
    .sort((left, right) =>
      `${left.file}:${left.line}:${left.method ?? ""}`.localeCompare(
        `${right.file}:${right.line}:${right.method ?? ""}`,
      ),
    )
    .filter((call) => {
      const identity = JSON.stringify(call);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
}

const manifest = {
  schemaVersion: 1,
  image: PINNED_IMAGE,
  dependencies: {
    bullmq: await dependencyVersion("bullmq"),
    ioredis: await dependencyVersion("ioredis"),
  },
  assumptions: {
    cloudflareQueuesDelivery: "retryable-at-least-once",
    acknowledgeAfterHandlerAndReceipt: true,
    durableExecutionReceipts: true,
    externalSideEffectsRequireIdempotency: true,
    unknownContractFailsClosed: true,
  },
  source: {
    compiledJavaScriptFiles: files.length,
    relevantRuntimeFiles: relevant.sort((a, b) => a.file.localeCompare(b.file)),
  },
  patchTargets,
  adapterContract: ADAPTER_METHODS,
  redisCalls: sortedUniqueCalls(redisCalls),
  cacheClientCalls: sortedUniqueCalls(cacheClientCalls),
  cachePipelineCalls: sortedUniqueCalls(cachePipelineCalls),
  subscriberCalls: sortedUniqueCalls(subscriberCalls),
  queueAdds: sortedUniqueCalls(queueAdds),
  scheduleCalls: sortedUniqueCalls(scheduleCalls),
  processors: sortedUniqueCalls(processors),
  processMethods: sortedUniqueCalls(processMethods),
  dependencyImports: sortedUniqueCalls(dependencyImports),
};
manifest.coverage = {
  uncoveredRedisMethods: {
    direct: uncovered(
      manifest.redisCalls.filter(({ accessor }) => accessor === "direct"),
      ADAPTER_METHODS.direct,
      ({ method }) => method,
    ),
    queue: uncovered(
      manifest.redisCalls.filter(({ accessor }) => accessor === "queue"),
      ADAPTER_METHODS.direct,
      ({ method }) => method,
    ),
    pubsub: uncovered(
      manifest.redisCalls.filter(({ accessor }) => accessor === "pubsub"),
      ADAPTER_METHODS.pubsub,
      ({ method }) => method,
    ),
  },
  uncoveredCacheClientMethods: uncovered(
    manifest.cacheClientCalls,
    ADAPTER_METHODS.cacheClient,
    ({ method }) => method,
  ),
  uncoveredCachePipelineMethods: uncovered(
    manifest.cachePipelineCalls,
    ADAPTER_METHODS.cachePipeline,
    ({ method }) => method,
  ),
  uncoveredSubscriberMethods: uncovered(
    manifest.subscriberCalls,
    ADAPTER_METHODS.subscriber,
    ({ method }) => method,
  ),
};

const encoded = `${JSON.stringify(manifest, null, 2)}\n`;
if (check) {
  const expected = await readFile(resolve(check), "utf8");
  const missingCoverage = Object.values(manifest.coverage)
    .flatMap((value) =>
      Array.isArray(value) ? value : Object.values(value).flat(),
    )
    .filter(Boolean);
  if (missingCoverage.length > 0) {
    console.error(
      `Twenty contract contains unsupported adapter methods: ${missingCoverage.join(", ")}`,
    );
    process.exitCode = 1;
  } else if (expected !== encoded) {
    console.error(
      "Twenty Redis/BullMQ contract drift detected. Regenerate and review docs/twenty-v2.20-contract.json.",
    );
    process.exitCode = 1;
  } else {
    console.log(
      `Twenty contract verified: ${manifest.source.relevantRuntimeFiles.length} relevant runtime files, ` +
        `${manifest.processors.length} processors, ${manifest.redisCalls.length} direct Redis calls.`,
    );
  }
} else if (output) {
  await writeFile(resolve(output), encoded, "utf8");
  console.log(`wrote Twenty contract manifest to ${resolve(output)}`);
} else {
  process.stdout.write(encoded);
}
