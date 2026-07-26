import { bearerAuthorized } from "../lib";
import type { Env } from "../types";
import {
  STATE_GATEWAY_MAX_BODY_BYTES,
  STATE_SCAN_MAX_ITEMS,
  STATE_KEY_MAX_LENGTH,
  STATE_NAMESPACE_MAX_LENGTH,
  STATE_SHARD_MAX_LENGTH,
  stateShardName,
  validStateKey,
  validStateKeys,
  validStateName,
  validTtl,
  type StateIncrementInput,
  type StateKeyInput,
  type StateLockInput,
  type StateSetInput,
} from "./contracts";

class StateGatewayInputError extends Error {}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length === 0 || text.length > STATE_GATEWAY_MAX_BODY_BYTES)
    throw new Error("invalid body size");
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("body must be an object");
  return parsed as Record<string, unknown>;
}

function keyInput(body: Record<string, unknown>): StateKeyInput {
  if (!validStateName(body.namespace, STATE_NAMESPACE_MAX_LENGTH))
    throw new StateGatewayInputError("invalid namespace");
  if (!validStateKey(body.key))
    throw new StateGatewayInputError("invalid key");
  return { namespace: body.namespace, key: body.key };
}

function namespaceInput(body: Record<string, unknown>): string {
  if (!validStateName(body.namespace, STATE_NAMESPACE_MAX_LENGTH))
    throw new StateGatewayInputError("invalid namespace");
  return body.namespace;
}

function stringList(value: unknown, label: string): string[] {
  if (!validStateKeys(value))
    throw new StateGatewayInputError(`invalid ${label}`);
  return value;
}

function jobExecutionOwner(body: Record<string, unknown>) {
  if (
    !validStateName(body.jobId, STATE_KEY_MAX_LENGTH) ||
    !validStateName(body.owner, STATE_KEY_MAX_LENGTH)
  )
    throw new StateGatewayInputError("invalid job execution owner");
  return { jobId: body.jobId, owner: body.owner };
}

export async function handleStateGateway(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!bearerAuthorized(request.headers.get("authorization"), env.INTERNAL_SERVICE_TOKEN))
    return json({ error: "unauthorized" }, 401);
  if (request.method !== "POST")
    return json({ error: "method not allowed" }, 405);

  const shardHeader = request.headers.get("x-twenty-state-shard");
  if (!shardHeader || shardHeader.length > STATE_SHARD_MAX_LENGTH)
    return json({ error: "invalid state shard" }, 400);

  let body: Record<string, unknown>;
  let shard: string;
  try {
    body = await readBody(request);
    shard = stateShardName(shardHeader);
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : "invalid request" },
      400,
    );
  }

  const path = new URL(request.url).pathname;

  try {
    const stub = env.STATE_DO.get(env.STATE_DO.idFromName(shard));
    switch (path) {
      case "/v1/job-execution/started":
        return json({
          started: await stub.markJobExecutionStarted(
            jobExecutionOwner(body),
          ),
        });
      case "/v1/state/get":
        return json(await stub.getValue(keyInput(body)));
      case "/v1/state/set": {
        const input: StateSetInput = { ...keyInput(body), value: body.value };
        if (!validTtl(body.ttlMs))
          return json({ error: "invalid ttlMs" }, 400);
        if (body.ttlMs !== undefined) input.ttlMs = body.ttlMs;
        return json(await stub.setValue(input));
      }
      case "/v1/state/delete":
        return json({ deleted: await stub.deleteValue(keyInput(body)) });
      case "/v1/state/mget":
        return json({
          values: await stub.getValues({
            namespace: namespaceInput(body),
            keys: stringList(body.keys, "keys"),
          }),
        });
      case "/v1/state/mdelete":
        return json({
          deleted: await stub.deleteValues({
            namespace: namespaceInput(body),
            keys: stringList(body.keys, "keys"),
          }),
        });
      case "/v1/state/expire": {
        if (!validTtl(body.ttlMs, true))
          return json({ error: "invalid ttlMs" }, 400);
        return json({
          updated: await stub.expireKey({
            ...keyInput(body),
            ttlMs: body.ttlMs,
          }),
        });
      }
      case "/v1/state/increment": {
        if (
          typeof body.delta !== "number" ||
          !Number.isSafeInteger(body.delta) ||
          !validTtl(body.ttlMs)
        )
          return json({ error: "invalid increment" }, 400);
        const input: StateIncrementInput = {
          ...keyInput(body),
          delta: body.delta,
        };
        if (body.ttlMs !== undefined) input.ttlMs = body.ttlMs;
        return json(await stub.increment(input));
      }
      case "/v1/set/add":
      case "/v1/set/remove": {
        const input = {
          ...keyInput(body),
          members: stringList(body.members, "members"),
        };
        const count =
          path === "/v1/set/add"
            ? await stub.setAdd(input)
            : await stub.setRemove(input);
        return json({ count });
      }
      case "/v1/set/pop":
        return json({ member: await stub.setPop(keyInput(body)) });
      case "/v1/set/card":
        return json({ count: await stub.setCard(keyInput(body)) });
      case "/v1/set/members":
        return json({ members: await stub.setMembers(keyInput(body)) });
      case "/v1/hash/values":
        return json({ values: await stub.hashValues(keyInput(body)) });
      case "/v1/hash/set": {
        if (
          !validStateKey(body.field) ||
          typeof body.value !== "string" ||
          !validTtl(body.ttlMs) ||
          (body.onlyIfKeyExists !== undefined &&
            typeof body.onlyIfKeyExists !== "boolean")
        )
          return json({ error: "invalid hash write" }, 400);
        return json({
          changed: await stub.hashSet({
            ...keyInput(body),
            field: body.field,
            value: body.value,
            ...(body.onlyIfKeyExists
              ? { onlyIfKeyExists: true }
              : {}),
            ...(body.ttlMs !== undefined ? { ttlMs: body.ttlMs } : {}),
          }),
        });
      }
      case "/v1/hash/delete": {
        if (!validStateKey(body.field))
          return json({ error: "invalid hash field" }, 400);
        return json({
          deleted: await stub.hashDelete({
            ...keyInput(body),
            field: body.field,
          }),
        });
      }
      case "/v1/list/append": {
        if (typeof body.value !== "string")
          return json({ error: "invalid list value" }, 400);
        return json({
          length: await stub.listAppend({
            ...keyInput(body),
            value: body.value,
          }),
        });
      }
      case "/v1/list/range":
        return json({ values: await stub.listRange(keyInput(body)) });
      case "/v1/state/scan": {
        if (
          typeof body.pattern !== "string" ||
          body.pattern.length === 0 ||
          body.pattern.length > STATE_KEY_MAX_LENGTH ||
          /[\u0000-\u001f\u007f]/.test(body.pattern) ||
          (body.after !== undefined && !validStateKey(body.after)) ||
          typeof body.limit !== "number" ||
          !Number.isSafeInteger(body.limit) ||
          body.limit < 1 ||
          body.limit > STATE_SCAN_MAX_ITEMS
        )
          return json({ error: "invalid scan" }, 400);
        return json(
          await stub.scanKeys({
            namespace: namespaceInput(body),
            pattern: body.pattern,
            ...(body.after !== undefined ? { after: body.after } : {}),
            limit: body.limit,
          }),
        );
      }
      case "/v1/state/clear":
        return json({
          deleted: await stub.clearNamespace(namespaceInput(body)),
        });
      case "/v1/lock/acquire": {
        if (
          !validStateName(body.owner, STATE_KEY_MAX_LENGTH) ||
          !validTtl(body.ttlMs, true)
        )
          return json({ error: "invalid lock" }, 400);
        const input: StateLockInput = {
          ...keyInput(body),
          owner: body.owner,
          ttlMs: body.ttlMs,
        };
        return json(await stub.acquireLock(input));
      }
      case "/v1/lock/release": {
        if (!validStateName(body.owner, STATE_KEY_MAX_LENGTH))
          return json({ error: "invalid lock owner" }, 400);
        return json({
          released: await stub.releaseLock({
            ...keyInput(body),
            owner: body.owner,
          }),
        });
      }
      case "/v1/state/health":
        return json(await stub.health());
      default:
        return json({ error: "not found" }, 404);
    }
  } catch (error) {
    if (error instanceof StateGatewayInputError)
      return json({ error: error.message }, 400);
    console.error("state gateway operation failed", { path, shard, error });
    return json({ error: "state operation failed" }, 500);
  }
}
