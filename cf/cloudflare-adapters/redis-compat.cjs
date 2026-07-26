"use strict";

const { CloudflareStateClient } = require("./state-client.cjs");

class CloudflareEventClient {
  constructor() {
    this.baseUrl =
      process.env.CLOUDFLARE_EVENTS_URL ?? "http://twenty-events.internal";
    this.token = process.env.INTERNAL_SERVICE_TOKEN;
    if (!this.token) throw new Error("INTERNAL_SERVICE_TOKEN is required");
  }

  async post(path, body, signal) {
    const timeout = AbortSignal.timeout(30_000);
    const response = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(
        `Cloudflare events ${path} failed (${response.status}): ${
          result.error ?? "unknown error"
        }`,
      );
    return result;
  }

  publish(channel, payload) {
    return this.post("/v1/events/publish", { channel, payload });
  }

  cursor(channel) {
    return this.post("/v1/events/cursor", { channel });
  }

  poll(channel, after, signal) {
    return this.post("/v1/events/poll", { channel, after }, signal).then(
      (result) => {
        if (result.gap) {
          const error = new Error(
            `Cloudflare realtime retention gap: requested ${result.gap.requestedCursor}, floor ${result.gap.retentionFloor}, latest ${result.gap.latestCursor}`,
          );
          error.code = "CLOUDFLARE_REALTIME_GAP";
          error.details = result.gap;
          throw error;
        }
        return result;
      },
    );
  }

  socketUrl() {
    const url = new URL("/v1/events/socket", this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
  }
}

class CloudflareRealtimeSocket {
  constructor(events, channel, onEvent, onError) {
    this.events = events;
    this.channel = channel;
    this.onEvent = onEvent;
    this.onError = onError;
    this.active = true;
    this.cursor = 0;
    this.retries = 0;
    this.socket = undefined;
    this.reconnectTimer = undefined;
  }

  start(after) {
    this.cursor = after;
    return this.connect(true);
  }

  connect(initial = false) {
    if (!this.active) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let ready = false;
      const socket = new WebSocket(this.events.socketUrl());
      this.socket = socket;
      const timeout = setTimeout(() => {
        if (ready || !this.active) return;
        socket.close(1013, "connect timeout");
        reject(new Error("Cloudflare realtime WebSocket connect timeout"));
      }, 10_000);
      socket.addEventListener("open", () => {
        socket.send(
          JSON.stringify({
            type: "authenticate",
            token: this.events.token,
            channel: this.channel,
            after: this.cursor,
          }),
        );
      });
      socket.addEventListener("message", (message) => {
        let frame;
        try {
          frame = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (frame.type === "event" && frame.event) {
          this.cursor = frame.event.id;
          this.onEvent(frame.event);
          return;
        }
        if (frame.type === "gap") {
          const error = new Error(
            `Cloudflare realtime retention gap: requested ${frame.requestedCursor}, floor ${frame.retentionFloor}, latest ${frame.latestCursor}`,
          );
          error.code = "CLOUDFLARE_REALTIME_GAP";
          error.details = frame;
          this.active = false;
          clearTimeout(timeout);
          this.onError(error);
          socket.close(4009, "retention gap");
          if (!ready) reject(error);
          return;
        }
        if (frame.type === "ready") {
          this.cursor = frame.cursor;
          this.retries = 0;
          ready = true;
          clearTimeout(timeout);
          resolve();
          if (frame.truncated) socket.close(1012, "continue replay");
        }
      });
      socket.addEventListener("error", () => {
        if (!ready && initial) {
          clearTimeout(timeout);
          reject(new Error("Cloudflare realtime WebSocket connection failed"));
        }
      });
      socket.addEventListener("close", () => {
        clearTimeout(timeout);
        if (!this.active) return;
        const delay = Math.min(250 * 2 ** this.retries, 5_000);
        this.retries = Math.min(this.retries + 1, 5);
        this.reconnectTimer = setTimeout(() => {
          void this.connect(false).catch((error) => this.onError(error));
        }, delay);
      });
    });
  }

  close() {
    this.active = false;
    clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "subscriber closed");
  }
}

class CloudflareAsyncIterator {
  constructor(events, channel) {
    this.events = events;
    this.channel = channel;
    this.stopped = false;
    this.controller = undefined;
    this.socket = undefined;
    this.socketQueue = [];
    this.socketWaiters = [];
    this.socketError = undefined;
    this.transport =
      process.env.CLOUDFLARE_PUBSUB_TRANSPORT !== "poll" &&
      typeof WebSocket === "function"
        ? "websocket"
        : "poll";
    this.cursorPromise = events.cursor(channel).then((result) => result.cursor);
    this.socketReady =
      this.transport === "websocket"
        ? this.cursorPromise
            .then((cursor) => {
              this.socket = new CloudflareRealtimeSocket(
                events,
                channel,
                (event) => this.pushSocketEvent(event),
                (error) => this.failSocket(error),
              );
              return this.socket.start(cursor);
            })
            .catch((error) => {
              this.transport = "poll";
              this.socket?.close();
              this.socket = undefined;
            })
        : Promise.resolve();
  }

  [Symbol.asyncIterator]() {
    return this;
  }

  async next() {
    await this.socketReady;
    if (this.transport === "websocket") {
      if (this.socketError) throw this.socketError;
      if (this.socketQueue.length > 0)
        return { done: false, value: this.socketQueue.shift().payload };
      if (this.stopped) return { done: true, value: undefined };
      return new Promise((resolve, reject) =>
        this.socketWaiters.push({ resolve, reject }),
      );
    }
    let cursor = await this.cursorPromise;
    while (!this.stopped) {
      this.controller = new AbortController();
      let event;
      try {
        ({ event } = await this.events.poll(
          this.channel,
          cursor,
          this.controller.signal,
        ));
      } catch (error) {
        if (this.stopped && error?.name === "AbortError")
          return { done: true, value: undefined };
        throw error;
      } finally {
        this.controller = undefined;
      }
      if (!event) continue;
      cursor = event.id;
      this.cursorPromise = Promise.resolve(cursor);
      return { done: false, value: event.payload };
    }
    return { done: true, value: undefined };
  }

  async return() {
    this.stopped = true;
    this.controller?.abort();
    this.socket?.close();
    for (const waiter of this.socketWaiters)
      waiter.resolve({ done: true, value: undefined });
    this.socketWaiters = [];
    return { done: true, value: undefined };
  }

  async throw(error) {
    this.stopped = true;
    this.controller?.abort();
    this.socket?.close();
    for (const waiter of this.socketWaiters) waiter.reject(error);
    this.socketWaiters = [];
    throw error;
  }

  pushSocketEvent(event) {
    const waiter = this.socketWaiters.shift();
    if (waiter) waiter.resolve({ done: false, value: event.payload });
    else this.socketQueue.push(event);
  }

  failSocket(error) {
    this.socketError = error;
    for (const waiter of this.socketWaiters) waiter.reject(error);
    this.socketWaiters = [];
  }
}

class CloudflarePubSub {
  constructor(events = new CloudflareEventClient()) {
    this.events = events;
  }

  async publish(channel, payload) {
    return (await this.events.publish(channel, payload)).id;
  }

  asyncIterator(channel) {
    return new CloudflareAsyncIterator(this.events, channel);
  }

  async close() {}
}

class CloudflareSubscriber {
  constructor(events) {
    this.events = events;
    this.callbacks = new Map();
    this.channels = new Map();
    this.closed = false;
  }

  on(event, callback) {
    this.callbacks.set(event, callback);
    return this;
  }

  async subscribe(channel) {
    if (this.channels.has(channel)) return 1;
    const state = {
      active: true,
      controller: undefined,
      retries: 0,
      socket: undefined,
    };
    this.channels.set(channel, state);
    let cursor = (await this.events.cursor(channel)).cursor;
    if (
      process.env.CLOUDFLARE_PUBSUB_TRANSPORT !== "poll" &&
      typeof WebSocket === "function"
    ) {
      state.socket = new CloudflareRealtimeSocket(
        this.events,
        channel,
        (event) => this.callbacks.get("message")?.(channel, event.payload),
        (error) => this.callbacks.get("error")?.(error),
      );
      try {
        await state.socket.start(cursor);
        return this.channels.size;
      } catch (error) {
        state.socket.close();
        state.socket = undefined;
        this.callbacks.get("error")?.(error);
      }
    }
    void (async () => {
      while (state.active && !this.closed) {
        try {
          state.controller = new AbortController();
          const { event } = await this.events.poll(
            channel,
            cursor,
            state.controller.signal,
          );
          state.controller = undefined;
          if (!event) continue;
          cursor = event.id;
          state.retries = 0;
          this.callbacks.get("message")?.(channel, event.payload);
        } catch (error) {
          state.controller = undefined;
          if (!state.active || this.closed) break;
          this.callbacks.get("error")?.(error);
          if (error?.code === "CLOUDFLARE_REALTIME_GAP") {
            state.active = false;
            this.channels.delete(channel);
            break;
          }
          const delay = Math.min(250 * 2 ** state.retries, 5_000);
          state.retries = Math.min(state.retries + 1, 5);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    })();
    return this.channels.size;
  }

  async unsubscribe(channel) {
    const state = this.channels.get(channel);
    if (state) {
      state.active = false;
      state.controller?.abort();
      state.socket?.close();
    }
    this.channels.delete(channel);
    return this.channels.size;
  }

  async quit() {
    this.closed = true;
    for (const state of this.channels.values()) {
      state.active = false;
      state.controller?.abort();
      state.socket?.close();
    }
    this.channels.clear();
    return "OK";
  }
}

class CloudflareRedisFacade {
  constructor() {
    this.state = new CloudflareStateClient({ namespace: "direct" });
    this.events = new CloudflareEventClient();
  }

  async set(key, value, mode, seconds) {
    const ttlMs = mode === "EX" ? seconds * 1000 : undefined;
    await this.state.set(key, value, ttlMs);
    return "OK";
  }

  async exists(key) {
    return (await this.state.get(key)).found ? 1 : 0;
  }

  async del(key) {
    return (await this.state.delete(key)).deleted ? 1 : 0;
  }

  async rpush(key, value) {
    return (await this.state.listAppend(key, value)).length;
  }

  async lrange(key, start, end) {
    if (start !== 0 || end !== -1)
      throw new Error("Cloudflare list facade only supports LRANGE 0 -1");
    return (await this.state.listRange(key)).values;
  }

  async expire(key, seconds) {
    return (await this.state.expire(key, seconds * 1000)).updated ? 1 : 0;
  }

  async publish(channel, payload) {
    return (await this.events.publish(channel, payload)).id;
  }

  duplicate() {
    return new CloudflareSubscriber(this.events);
  }

  async info() {
    return [
      "redis_version:cloudflare-native",
      "uptime_in_seconds:0",
      "used_memory_human:n/a",
      "used_memory_peak_human:n/a",
      "mem_fragmentation_ratio:0",
      "connected_clients:0",
      "total_connections_received:0",
      "rejected_connections:0",
      "instantaneous_ops_per_sec:0",
      "keyspace_hits:0",
      "keyspace_misses:0",
      "evicted_keys:0",
      "expired_keys:0",
      "role:cloudflare",
      "connected_slaves:0",
    ].join("\r\n");
  }

  async quit() {
    return "OK";
  }
}

module.exports = {
  CloudflareEventClient,
  CloudflareAsyncIterator,
  CloudflareRealtimeSocket,
  CloudflarePubSub,
  CloudflareRedisFacade,
  CloudflareSubscriber,
};
