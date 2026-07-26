const TARGET_IMAGE =
  "twentycrm/twenty@sha256:d3dd949725e6196c57dab66ebe83ba9cdd2561885c35f94ef20f9ae38cd6d333";
const CAPTURE_IMAGE =
  "twentycrm/twenty-app-dev@sha256:9932df2e4db0db12cbf51d0ed5fa4f6c6849cb320e6fa94fe78cf315a7162ad2";

const UNEXERCISED_SCENARIOS = [
  "ai-cancel-and-heartbeat",
  "authenticated-cache-invalidation",
  "authenticated-login-logout",
  "delayed-job-delivery",
  "failed-job-retry-and-dlq",
  "graphql-subscription-reconnect",
  "job-crash-and-stall-recovery",
  "workflow-crud-and-execution",
];

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function quotedTokens(line) {
  const values = [];
  const pattern = /"((?:\\.|[^"\\])*)"/g;
  for (const match of line.matchAll(pattern)) values.push(match[1]);
  return values;
}

function monitorLine(line) {
  const match = line.match(
    /^\d+(?:\.\d+)?\s+\[(\d+)\s+([^\]]+)\]\s+("[\s\S]+")$/,
  );
  if (!match) return null;

  const tokens = quotedTokens(match[3]);
  if (tokens.length === 0) return null;

  return {
    database: Number(match[1]),
    client: match[2],
    command: tokens[0].toLowerCase(),
    rawArguments: match[3],
    tokens,
  };
}

export function normalizeRedisMonitorTrace(rawTrace, scenarios) {
  const bullmqClientCommands = new Set();
  const bullmqLuaEffectCommands = new Set();
  const directOrPlatformCommands = new Set();
  const evalshaDigests = new Set();
  const queueNames = new Set();
  let parsedLines = 0;

  for (const line of rawTrace.split(/\r?\n/)) {
    const parsed = monitorLine(line);
    if (!parsed) continue;
    parsedLines++;

    const bullmqKey = /bull:([^:\s"\\]+):/g;
    for (const match of parsed.rawArguments.matchAll(bullmqKey)) {
      queueNames.add(match[1]);
    }

    const isBullmq = parsed.rawArguments.includes("bull:");
    if (parsed.command === "evalsha" && parsed.tokens[1]) {
      const digest = parsed.tokens[1].toLowerCase();
      if (/^[a-f0-9]{40}$/.test(digest)) evalshaDigests.add(digest);
    }

    if (isBullmq && parsed.client === "lua") {
      bullmqLuaEffectCommands.add(parsed.command);
    } else if (isBullmq) {
      bullmqClientCommands.add(parsed.command);
    } else {
      directOrPlatformCommands.add(parsed.command);
    }
  }

  if (parsedLines === 0) {
    throw new Error("Redis MONITOR trace did not contain any parseable commands");
  }

  const normalizedScenarios = scenarios
    .map(({ name, method, path, status }) => ({
      name,
      method,
      path,
      status,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    schemaVersion: 1,
    targetImage: TARGET_IMAGE,
    captureImage: CAPTURE_IMAGE,
    captureProfile: "boot-and-anonymous-http-v1",
    scenarios: normalizedScenarios,
    observations: {
      bullmqClientCommands: sorted(bullmqClientCommands),
      bullmqLuaEffectCommands: sorted(bullmqLuaEffectCommands),
      directOrPlatformCommands: sorted(directOrPlatformCommands),
      evalshaDigests: sorted(evalshaDigests),
      queueNames: sorted(queueNames),
    },
    privacy: {
      rawTracePersisted: false,
      retainedFields: [
        "command-families",
        "evalsha-digests",
        "queue-names",
        "scenario-status-codes",
      ],
    },
    coverage: {
      status: "partial",
      unexercisedScenarios: UNEXERCISED_SCENARIOS,
      note:
        "This runtime baseline proves boot, health, anonymous GraphQL, and observed BullMQ command families only. G1 remains partial until authenticated and failure-path scenarios are captured and replayed.",
    },
  };
}

export { CAPTURE_IMAGE, TARGET_IMAGE, UNEXERCISED_SCENARIOS };
