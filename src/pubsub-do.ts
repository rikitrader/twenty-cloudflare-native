import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

const EVENT_TTL_MS = 60 * 60_000;
const MAX_POLL_MS = 25_000;
const MAX_REPLAY_EVENTS = 1_000;

interface EventRow {
  [key: string]: string | number;
  id: number;
  payload_json: string;
}

interface CursorRow {
  [key: string]: number;
  id: number;
}

interface ChannelRow {
  [key: string]: string | number;
  latest_id: number;
  retention_floor: number;
}

export interface PubSubEvent {
  id: number;
  payload: unknown;
}

export interface PubSubReplay {
  events: PubSubEvent[];
  latestCursor: number;
  retentionFloor: number;
  gap: boolean;
  truncated: boolean;
}

interface SocketAttachment {
  authenticated: boolean;
  channel?: string;
  cursor?: number;
}

export class TwentyPubSub extends DurableObject<Env> {
  private waiters = new Map<
    string,
    Set<(event: PubSubEvent | null) => void>
  >();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS pubsub_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pubsub_channel_id
        ON pubsub_events (channel, id);
      CREATE INDEX IF NOT EXISTS pubsub_created_at
        ON pubsub_events (created_at);

      CREATE TABLE IF NOT EXISTS pubsub_channels (
        channel TEXT PRIMARY KEY,
        latest_id INTEGER NOT NULL DEFAULT 0,
        retention_floor INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS pubsub_dedupe (
        event_key TEXT PRIMARY KEY,
        event_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      INSERT OR IGNORE INTO pubsub_channels (
        channel, latest_id, retention_floor
      )
      SELECT channel, MAX(id), 0
      FROM pubsub_events
      GROUP BY channel;
    `);
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong"),
    );
  }

  async cursor(channel: string): Promise<number> {
    return (
      this.ctx.storage.sql
        .exec<ChannelRow>(
          `SELECT latest_id, retention_floor
           FROM pubsub_channels WHERE channel = ?`,
          channel,
        )
        .toArray()[0]?.latest_id ?? 0
    );
  }

  async replay(
    channel: string,
    after: number,
    limit = MAX_REPLAY_EVENTS,
  ): Promise<PubSubReplay> {
    const channelState = this.ctx.storage.sql
      .exec<ChannelRow>(
        `SELECT latest_id, retention_floor
         FROM pubsub_channels WHERE channel = ?`,
        channel,
      )
      .toArray()[0] ?? { latest_id: 0, retention_floor: 0 };
    if (after < channelState.retention_floor) {
      return {
        events: [],
        latestCursor: channelState.latest_id,
        retentionFloor: channelState.retention_floor,
        gap: true,
        truncated: false,
      };
    }
    const boundedLimit = Math.min(Math.max(limit, 1), MAX_REPLAY_EVENTS);
    const rows = this.ctx.storage.sql
      .exec<EventRow>(
        `SELECT id, payload_json FROM pubsub_events
         WHERE channel = ? AND id > ? ORDER BY id LIMIT ?`,
        channel,
        after,
        boundedLimit + 1,
      )
      .toArray();
    return {
      events: rows.slice(0, boundedLimit).map((row) => ({
        id: row.id,
        payload: JSON.parse(row.payload_json) as unknown,
      })),
      latestCursor: channelState.latest_id,
      retentionFloor: channelState.retention_floor,
      gap: false,
      truncated: rows.length > boundedLimit,
    };
  }

  private next(channel: string, after: number): PubSubEvent | null {
    const row = this.ctx.storage.sql
      .exec<EventRow>(
        `SELECT id, payload_json FROM pubsub_events
         WHERE channel = ? AND id > ? ORDER BY id LIMIT 1`,
        channel,
        after,
      )
      .toArray()[0];
    return row
      ? { id: row.id, payload: JSON.parse(row.payload_json) as unknown }
      : null;
  }

  async publish(channel: string, payload: unknown): Promise<number> {
    const encoded = JSON.stringify(payload);
    if (encoded === undefined) throw new Error("event is not JSON serializable");
    const outcome = this.ctx.storage.transactionSync(() => {
      const eventKey = payload && typeof payload === 'object' && typeof (payload as Record<string,unknown>).eventId === 'string' ? String((payload as Record<string,unknown>).eventId) : null;
      if (eventKey) {
        const prior = this.ctx.storage.sql.exec<CursorRow>('SELECT event_id AS id FROM pubsub_dedupe WHERE event_key=?',eventKey).toArray()[0];
        if (prior) return {id:prior.id,inserted:false};
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO pubsub_events (channel, payload_json, created_at)
         VALUES (?, ?, ?)`,
        channel,
        encoded,
        Date.now(),
      );
      const insertedId = this.ctx.storage.sql
        .exec<CursorRow>("SELECT last_insert_rowid() AS id")
        .one().id;
      this.ctx.storage.sql.exec(
        `INSERT INTO pubsub_channels (
           channel, latest_id, retention_floor
         ) VALUES (?, ?, 0)
         ON CONFLICT(channel) DO UPDATE SET latest_id = excluded.latest_id`,
        channel,
        insertedId,
      );
      if (eventKey) this.ctx.storage.sql.exec('INSERT INTO pubsub_dedupe (event_key,event_id,created_at) VALUES (?,?,?)',eventKey,insertedId,Date.now());
      return {id:insertedId,inserted:true};
    });
    if (!outcome.inserted) return outcome.id;
    const id=outcome.id;
    const event = { id, payload };
    for (const resolve of this.waiters.get(channel) ?? []) resolve(event);
    this.waiters.delete(channel);
    const message = JSON.stringify({ type: "event", event });
    for (const socket of this.ctx.getWebSockets()) {
      const attachment =
        socket.deserializeAttachment() as SocketAttachment | null;
      if (
        !attachment?.authenticated ||
        attachment.channel !== channel ||
        id <= (attachment.cursor ?? 0)
      )
        continue;
      try {
        socket.send(message);
        socket.serializeAttachment({ ...attachment, cursor: id });
      } catch {
        socket.close(1011, "delivery failed");
      }
    }
    await this.ctx.storage.setAlarm(Date.now() + EVENT_TTL_MS);
    return id;
  }

  async poll(
    channel: string,
    after: number,
    timeoutMs = MAX_POLL_MS,
  ): Promise<PubSubEvent | null> {
    const available = this.next(channel, after);
    if (available) return available;
    const boundedTimeout = Math.min(Math.max(timeoutMs, 1), MAX_POLL_MS);
    return new Promise((resolve) => {
      const channelWaiters = this.waiters.get(channel) ?? new Set();
      let settled = false;
      const finish = (event: PubSubEvent | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channelWaiters.delete(finish);
        if (channelWaiters.size === 0) this.waiters.delete(channel);
        resolve(event);
      };
      const timer = setTimeout(() => finish(null), boundedTimeout);
      channelWaiters.add(finish);
      this.waiters.set(channel, channelWaiters);
    });
  }

  async alarm(): Promise<void> {
    const expiresBefore = Date.now() - EVENT_TTL_MS;
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT INTO pubsub_channels (
           channel, latest_id, retention_floor
         )
         SELECT channel, MAX(id), MAX(id)
         FROM pubsub_events
         WHERE created_at <= ?
         GROUP BY channel
         ON CONFLICT(channel) DO UPDATE SET
           latest_id = MAX(pubsub_channels.latest_id, excluded.latest_id),
           retention_floor = MAX(
             pubsub_channels.retention_floor,
             excluded.retention_floor
           )`,
        expiresBefore,
      );
      this.ctx.storage.sql.exec(
        "DELETE FROM pubsub_events WHERE created_at <= ?",
        expiresBefore,
      );
      this.ctx.storage.sql.exec('DELETE FROM pubsub_dedupe WHERE created_at <= ?',expiresBefore);
    });
    const remaining = this.ctx.storage.sql
      .exec<CursorRow>("SELECT COUNT(*) AS id FROM pubsub_events")
      .one().id;
    if (remaining > 0) await this.ctx.storage.setAlarm(Date.now() + EVENT_TTL_MS);
  }

  async pruneForCanary(channel: string, throughId: number): Promise<void> {
    if (this.env.CANARY_MODE !== "true")
      throw new Error("canary-only operation");
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `DELETE FROM pubsub_events
         WHERE channel = ? AND id <= ?`,
        channel,
        throughId,
      );
      this.ctx.storage.sql.exec(
        `UPDATE pubsub_channels
         SET retention_floor = MAX(retention_floor, ?)
         WHERE channel = ?`,
        throughId,
        channel,
      );
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
      return Response.json({ error: "websocket upgrade required" }, { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const authorization = request.headers.get("authorization");
    const preAuthenticated =
      Boolean(this.env.INTERNAL_SERVICE_TOKEN) &&
      authorization === `Bearer ${this.env.INTERNAL_SERVICE_TOKEN}`;
    const url = new URL(request.url);
    const channel = url.searchParams.get("channel") ?? undefined;
    const parsedAfter = Number(url.searchParams.get("after") ?? "0");
    const after =
      Number.isSafeInteger(parsedAfter) && parsedAfter >= 0 ? parsedAfter : 0;
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      authenticated: preAuthenticated,
      ...(preAuthenticated && channel ? { channel, cursor: after } : {}),
    } satisfies SocketAttachment);
    if (preAuthenticated && channel)
      this.sendReplay(server, channel, after);
    else server.send(JSON.stringify({ type: "authenticate" }));
    return new Response(null, { status: 101, webSocket: client });
  }

  private sendReplay(socket: WebSocket, channel: string, after: number): void {
    const replay = this.replaySync(channel, after);
    if (replay.gap) {
      socket.send(
        JSON.stringify({
          type: "gap",
          requestedCursor: after,
          retentionFloor: replay.retentionFloor,
          latestCursor: replay.latestCursor,
        }),
      );
      socket.close(4009, "retention gap");
      return;
    }
    let cursor = after;
    for (const event of replay.events) {
      socket.send(JSON.stringify({ type: "event", event }));
      cursor = event.id;
    }
    socket.serializeAttachment({
      authenticated: true,
      channel,
      cursor,
    } satisfies SocketAttachment);
    socket.send(
      JSON.stringify({
        type: "ready",
        cursor,
        latestCursor: replay.latestCursor,
        truncated: replay.truncated,
      }),
    );
  }

  private replaySync(channel: string, after: number): PubSubReplay {
    const channelState = this.ctx.storage.sql
      .exec<ChannelRow>(
        `SELECT latest_id, retention_floor
         FROM pubsub_channels WHERE channel = ?`,
        channel,
      )
      .toArray()[0] ?? { latest_id: 0, retention_floor: 0 };
    if (after < channelState.retention_floor)
      return {
        events: [],
        latestCursor: channelState.latest_id,
        retentionFloor: channelState.retention_floor,
        gap: true,
        truncated: false,
      };
    const rows = this.ctx.storage.sql
      .exec<EventRow>(
        `SELECT id, payload_json FROM pubsub_events
         WHERE channel = ? AND id > ? ORDER BY id LIMIT ?`,
        channel,
        after,
        MAX_REPLAY_EVENTS + 1,
      )
      .toArray();
    return {
      events: rows.slice(0, MAX_REPLAY_EVENTS).map((row) => ({
        id: row.id,
        payload: JSON.parse(row.payload_json) as unknown,
      })),
      latestCursor: channelState.latest_id,
      retentionFloor: channelState.retention_floor,
      gap: false,
      truncated: rows.length > MAX_REPLAY_EVENTS,
    };
  }

  async webSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment =
      socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.authenticated) return;
    if (typeof message !== "string") {
      socket.close(1003, "text messages required");
      return;
    }
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(message) as Record<string, unknown>;
    } catch {
      socket.close(1008, "invalid authentication");
      return;
    }
    if (
      body.type !== "authenticate" ||
      body.token !== this.env.INTERNAL_SERVICE_TOKEN ||
      typeof body.channel !== "string" ||
      body.channel.length === 0 ||
      body.channel.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(body.channel) ||
      typeof body.after !== "number" ||
      !Number.isSafeInteger(body.after) ||
      body.after < 0
    ) {
      socket.close(1008, "invalid authentication");
      return;
    }
    this.sendReplay(socket, body.channel, body.after);
  }

  async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
    // These reserved status codes can describe an abnormal peer disconnect,
    // but they cannot legally be sent in a WebSocket close frame.
    if (code === 1005 || code === 1006) return;
    socket.close(code, reason);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    socket.close(1011, "websocket error");
  }
}
