/**
 * Productor relay: holds GitHub webhooks and schedule firings until the Mac
 * app is awake to collect them.
 *
 *   POST /hooks/github   GitHub webhook receiver (HMAC-verified)
 *   GET  /connect        WebSocket for the Mac app (bearer token)
 *   GET  /health         liveness check
 *
 * Over the WebSocket the app sends `hello` with its schedules and `ack` for
 * events it has stored; the relay sends each pending `event` until acked.
 */
import { DurableObject } from "cloudflare:workers";
import { nextFire, type Schedule } from "./schedule";

interface Env {
  RELAY: DurableObjectNamespace<Relay>;
  RELAY_TOKEN: string;
  GITHUB_WEBHOOK_SECRET: string;
}

interface ScheduleEntry {
  id: string;
  schedule: Schedule;
}

type ClientMessage =
  | { type: "hello"; timeZone: string; schedules: ScheduleEntry[] }
  | { type: "ack"; ids: string[] };

const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60_000;
const MAX_EVENTS = 500;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

async function githubSignature(secret: string, body: ArrayBuffer): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return "sha256=" + [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const relay = env.RELAY.get(env.RELAY.idFromName("relay"));

    if (url.pathname === "/health") return new Response("ok");

    if (url.pathname === "/hooks/github" && request.method === "POST") {
      if (!env.GITHUB_WEBHOOK_SECRET) return new Response("webhook secret not configured", { status: 503 });
      const body = await request.arrayBuffer();
      if (body.byteLength > MAX_BODY_BYTES) return new Response("payload too large", { status: 413 });
      const expected = await githubSignature(env.GITHUB_WEBHOOK_SECRET, body);
      const given = request.headers.get("x-hub-signature-256") ?? "";
      if (!timingSafeEqual(expected, given)) return new Response("bad signature", { status: 401 });

      const name = request.headers.get("x-github-event") ?? "unknown";
      // GitHub retries deliveries with the same id; using it as the event id
      // makes a retry overwrite rather than duplicate.
      const delivery = request.headers.get("x-github-delivery") ?? crypto.randomUUID();
      if (name !== "ping") {
        await relay.enqueue({
          id: `github:${delivery}`,
          source: "github",
          name,
          payload: new TextDecoder().decode(body),
        });
      }
      return new Response("accepted", { status: 202 });
    }

    if (url.pathname === "/connect") {
      if (!env.RELAY_TOKEN) return new Response("relay token not configured", { status: 503 });
      const given = request.headers.get("authorization") ?? "";
      if (!timingSafeEqual(`Bearer ${env.RELAY_TOKEN}`, given)) {
        return new Response("unauthorized", { status: 401 });
      }
      if (request.headers.get("upgrade") !== "websocket") {
        return new Response("expected a WebSocket", { status: 426 });
      }
      return relay.fetch(request);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

interface NewEvent {
  id: string;
  source: "github" | "schedule";
  /** GitHub event name, or the automation id for a schedule firing. */
  name: string;
  /** Raw JSON payload; empty for schedule firings. */
  payload: string;
}

export class Relay extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        name TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedules (
        id TEXT PRIMARY KEY,
        spec TEXT NOT NULL,
        next_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  /** Stores an event and pushes it to the Mac app if it is connected. */
  async enqueue(event: NewEvent): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      "INSERT OR REPLACE INTO events (id, source, name, payload, created_at) VALUES (?, ?, ?, ?, ?)",
      event.id, event.source, event.name, event.payload, now,
    );
    // Bound the backlog in case the Mac stays away for a long time.
    this.sql.exec("DELETE FROM events WHERE created_at < ?", now - MAX_EVENT_AGE_MS);
    this.sql.exec(
      "DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY created_at DESC LIMIT ?)",
      MAX_EVENTS,
    );
    for (const socket of this.ctx.getWebSockets()) this.send(socket, { ...event, at: now });
  }

  private send(socket: WebSocket, event: NewEvent & { at: number }) {
    try {
      socket.send(JSON.stringify({ type: "event", ...event }));
    } catch {
      // A dead socket is cleaned up by its close handler; the event stays
      // queued for the next connection.
    }
  }

  async fetch(): Promise<Response> {
    const pair = new WebSocketPair();
    // Hibernation lets the object sleep between messages without dropping
    // the connection.
    this.ctx.acceptWebSocket(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    let message: ClientMessage;
    try {
      message = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (message.type === "ack") {
      for (const id of message.ids) this.sql.exec("DELETE FROM events WHERE id = ?", id);
    } else if (message.type === "hello") {
      await this.syncSchedules(message.timeZone, message.schedules);
      const pending = this.sql
        .exec<{ id: string; source: "github" | "schedule"; name: string; payload: string; created_at: number }>(
          "SELECT * FROM events ORDER BY created_at",
        )
        .toArray();
      for (const row of pending) {
        this.send(socket, { id: row.id, source: row.source, name: row.name, payload: row.payload, at: row.created_at });
      }
      socket.send(JSON.stringify({ type: "ready", pending: pending.length }));
    }
  }

  async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code);
    } catch {
      // Already closed.
    }
  }

  /** Replaces the schedule set, keeping the next firing of unchanged ones. */
  private async syncSchedules(timeZone: string, schedules: ScheduleEntry[]): Promise<void> {
    const now = Date.now();
    this.sql.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('timeZone', ?)", timeZone);
    const existing = new Map(
      this.sql.exec<{ id: string; spec: string }>("SELECT id, spec FROM schedules").toArray().map((r) => [r.id, r.spec]),
    );
    for (const entry of schedules) {
      const spec = JSON.stringify(entry.schedule);
      if (existing.get(entry.id) !== spec) {
        this.sql.exec(
          "INSERT OR REPLACE INTO schedules (id, spec, next_at) VALUES (?, ?, ?)",
          entry.id, spec, nextFire(entry.schedule, now, timeZone),
        );
      }
      existing.delete(entry.id);
    }
    for (const removed of existing.keys()) {
      this.sql.exec("DELETE FROM schedules WHERE id = ?", removed);
      this.sql.exec("DELETE FROM events WHERE id = ?", `schedule:${removed}`);
    }
    await this.armAlarm();
  }

  private async armAlarm(): Promise<void> {
    const next = this.sql.exec<{ next_at: number | null }>("SELECT MIN(next_at) AS next_at FROM schedules").one().next_at;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const timeZone =
      this.sql.exec<{ value: string }>("SELECT value FROM settings WHERE key = 'timeZone'").toArray()[0]?.value ?? "UTC";
    const due = this.sql
      .exec<{ id: string; spec: string }>("SELECT id, spec FROM schedules WHERE next_at <= ?", now)
      .toArray();
    for (const row of due) {
      // One id per schedule: if the Mac was away for several firings they
      // collapse into a single pending event instead of a burst.
      await this.enqueue({ id: `schedule:${row.id}`, source: "schedule", name: row.id, payload: "" });
      this.sql.exec(
        "UPDATE schedules SET next_at = ? WHERE id = ?",
        nextFire(JSON.parse(row.spec) as Schedule, now, timeZone),
        row.id,
      );
    }
    await this.armAlarm();
  }
}
