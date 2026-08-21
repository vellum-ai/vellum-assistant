/**
 * Connection-lifecycle tests for the Slack Socket Mode client.
 *
 * The defect these exist to pin: a Socket Mode connection could stop
 * delivering while remaining open at the socket layer, and nothing in the
 * gateway could notice. Recovery waited on a close event that a half-open
 * socket never fires, so delivery stayed dead until something unrelated
 * bounced the channel stack.
 *
 * The load-bearing case is "half-open socket recovers with no close event".
 * The fake socket below therefore never emits `close` on its own; anything
 * these tests observe has to come from the client deciding for itself.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { GatewayConfig } from "../config.js";
import type { NormalizedSlackEvent } from "../slack/message-schemas.js";
import {
  DEFAULT_PONG_DEADLINE_MS,
  DEFAULT_PROBE_INTERVAL_MS,
} from "../slack/socket-liveness.js";
import type { CancelTimer, ScheduleFn } from "../util/schedule.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(async () => {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

// The lifecycle under test touches the store only to bootstrap the catch-up
// watermark, so a stub keeps these tests about the connection.
mock.module("../db/slack-store.js", () => ({
  SlackStore: class {
    getLastSeenTs(): string | undefined {
      return undefined;
    }
    setLastSeenTsIfGreater(): void {}
    cleanupExpiredEvents(): number {
      return 0;
    }
    cleanupExpiredThreads(): number {
      return 0;
    }
  },
}));

const { SlackSocketModeClient } = await import("../slack/socket-mode.js");
import type {
  SlackSocketLike,
  SlackSocketModeConfig,
} from "../slack/socket-mode.js";
import { CONNECT_DEADLINE_MS, MAX_BACKOFF_MS } from "../slack/socket-mode.js";

/** Deterministic stand-in for the client's timers. */
class FakeClock {
  private current = 0;
  private queue: { fn: () => void; dueAt: number; cancelled: boolean }[] = [];

  readonly now = (): number => this.current;

  readonly schedule: ScheduleFn = (fn, delayMs): CancelTimer => {
    const entry = { fn, dueAt: this.current + delayMs, cancelled: false };
    this.queue.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };

  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.queue
        .filter((e) => !e.cancelled && e.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (!due) {
        break;
      }
      this.queue = this.queue.filter((e) => e !== due);
      this.current = due.dueAt;
      due.fn();
    }
    this.current = target;
  }
}

/**
 * A socket that does exactly what a half-open connection does: it accepts
 * frames, reports itself OPEN, and never volunteers a close event. Tests opt
 * into liveness by calling `emitPong()`.
 */
class FakeSocket implements SlackSocketLike {
  readyState = 1; // WebSocket.OPEN
  pings = 0;
  closeCalls: { code?: number; reason?: string }[] = [];
  sent: string[] = [];
  private listeners = new Map<
    string,
    { listener: (event: never) => void; once: boolean }[]
  >();

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    // Deliberately no close event: that is the failure being reproduced.
  }

  ping(): void {
    this.pings++;
  }

  addEventListener(
    type: string,
    listener: (event: never) => void,
    options?: { once?: boolean },
  ): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push({ listener, once: options?.once === true });
    this.listeners.set(type, existing);
  }

  private emit(type: string, event?: unknown): void {
    const registered = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      registered.filter((entry) => !entry.once),
    );
    for (const entry of registered) {
      (entry.listener as (e: unknown) => void)(event);
    }
  }

  emitOpen(): void {
    this.emit("open");
  }

  emitPong(): void {
    this.emit("pong");
  }

  emitMessage(data: string): void {
    this.emit("message", { data });
  }

  emitClose(code: number, reason: string): void {
    this.readyState = 3; // WebSocket.CLOSED
    this.emit("close", { code, reason });
  }
}

function makeGatewayConfig(): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    maxWebhookPayloadBytes: 1024 * 1024,
    port: 7830,
    routingEntries: [],
    runtimeInitialBackoffMs: 500,
    runtimeMaxRetries: 2,
    runtimeProxyRequireAuth: false,
    runtimeTimeoutMs: 30000,
    shutdownDrainMs: 5000,
    trustProxy: false,
  } as unknown as GatewayConfig;
}

function makeConfig(): SlackSocketModeConfig {
  return {
    appToken: "xapp-test",
    botToken: "xoxb-test",
    // A fully populated identity keeps `auth.test` off the wire, so the only
    // fetch these tests exercise is `apps.connections.open`.
    botUserId: "UBOT",
    botUsername: "assistant",
    botId: "BBOT",
    teamName: "Example Team",
    gatewayConfig: makeGatewayConfig(),
    threadMode: "mention_then_thread",
  };
}

/** Let the client's async connect chain settle. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function startClient(
  onEvent: (e: NormalizedSlackEvent) => void = () => {},
) {
  const clock = new FakeClock();
  const sockets: FakeSocket[] = [];
  const client = new SlackSocketModeClient(makeConfig(), onEvent, {
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    schedule: clock.schedule,
    now: clock.now,
  });
  await client.start();
  await flush();
  return { clock, sockets, client };
}

beforeEach(() => {
  fetchMock = mock(async (input) => {
    if (String(input).includes("apps.connections.open")) {
      return new Response(
        JSON.stringify({ ok: true, url: "wss://slack.test/socket" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({ ok: true, messages: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
});

describe("Slack Socket Mode liveness", () => {
  test("probes the live socket once the connection is open", async () => {
    const { clock, sockets, client } = await startClient();
    expect(sockets).toHaveLength(1);

    sockets[0].emitOpen();
    await flush();
    expect(sockets[0].pings).toBe(0);

    clock.advance(DEFAULT_PROBE_INTERVAL_MS);
    expect(sockets[0].pings).toBe(1);

    client.stop();
  });

  test("recovers a half-open socket that never fires a close event", async () => {
    const { clock, sockets, client } = await startClient();
    sockets[0].emitOpen();
    await flush();

    // The connection goes silent. No frames, no error, no close: from the
    // socket's own account it is still open.
    clock.advance(DEFAULT_PROBE_INTERVAL_MS);
    expect(sockets[0].pings).toBe(1);

    clock.advance(DEFAULT_PONG_DEADLINE_MS);

    // The client gave up on it and tore it down itself.
    expect(sockets[0].closeCalls).toEqual([
      { code: 1000, reason: "force reconnect" },
    ]);

    // forceReconnect waits briefly for a close event that never comes, then
    // proceeds anyway.
    clock.advance(5_000);
    await flush();

    // The replacement is paced by the capped exponential backoff rather than
    // dialled immediately, so a Slack edge outage cannot become a fixed-rate
    // `apps.connections.open` loop.
    expect(sockets).toHaveLength(1);

    clock.advance(MAX_BACKOFF_MS);
    await flush();

    // This is the assertion that matters: a replacement connection exists
    // even though the dead socket reported nothing at any point, which is
    // precisely what the old code could not do.
    expect(sockets).toHaveLength(2);
    expect(sockets[1]).not.toBe(sockets[0]);

    client.stop();
  });

  test("detection stays inside one probe interval plus one deadline", async () => {
    const { clock, sockets, client } = await startClient();
    sockets[0].emitOpen();
    await flush();

    clock.advance(DEFAULT_PROBE_INTERVAL_MS + DEFAULT_PONG_DEADLINE_MS - 1);
    expect(sockets[0].closeCalls).toHaveLength(0);

    clock.advance(1);
    expect(sockets[0].closeCalls).toHaveLength(1);

    // Worst case is bounded well under two minutes, against an outage that
    // previously ran for hours.
    expect(DEFAULT_PROBE_INTERVAL_MS + DEFAULT_PONG_DEADLINE_MS).toBeLessThan(
      120_000,
    );

    client.stop();
  });

  test("a healthy but silent socket is never torn down", async () => {
    // The regression guard for a passive idle timeout: this connection
    // delivers no events for hours and must survive untouched.
    const { clock, sockets, client } = await startClient();
    sockets[0].emitOpen();
    await flush();

    // Twelve hours of a workspace saying nothing at all, which is longer
    // than the outage that prompted this and well past any inbound-silence
    // threshold a passive watchdog could have used.
    for (let i = 0; i < 12 * 60; i++) {
      clock.advance(DEFAULT_PROBE_INTERVAL_MS);
      sockets[0].emitPong();
    }

    expect(sockets[0].closeCalls).toHaveLength(0);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].pings).toBe(12 * 60);

    client.stop();
  });

  test("stops probing a socket that closed normally", async () => {
    const { clock, sockets, client } = await startClient();
    sockets[0].emitOpen();
    await flush();

    sockets[0].emitClose(1000, "client shutdown");

    clock.advance(DEFAULT_PROBE_INTERVAL_MS * 5);

    // No probe against a socket already known to be gone, and no second
    // teardown racing the reconnect the close handler scheduled.
    expect(sockets[0].pings).toBe(0);
    expect(sockets[0].closeCalls).toHaveLength(0);

    client.stop();
  });

  test("replaces a socket whose handshake never completes", async () => {
    const { clock, sockets, client } = await startClient();
    expect(sockets).toHaveLength(1);

    // No `open`, and no `close` either: the shape the liveness watchdog
    // cannot see because it only arms on an established connection.
    clock.advance(CONNECT_DEADLINE_MS);
    expect(sockets[0].closeCalls).toHaveLength(1);

    clock.advance(5_000);
    await flush();
    expect(sockets).toHaveLength(1);

    clock.advance(MAX_BACKOFF_MS);
    await flush();
    expect(sockets).toHaveLength(2);

    client.stop();
  });

  test("a Slack-requested rotation does not orphan the watchdog", async () => {
    // Slack rotates Socket Mode connections on a routine cadence. That path
    // abandons the socket itself, so the close handler's identity guard is
    // already false and cannot stop the watchdog on its behalf. A watchdog
    // left armed against the rotated-away socket would fire a minute later
    // and tear down the healthy replacement, turning every rotation into a
    // reconnect storm.
    const { clock, sockets, client } = await startClient();
    sockets[0].emitOpen();
    await flush();

    sockets[0].emitMessage(
      JSON.stringify({ type: "disconnect", reason: "refresh_requested" }),
    );
    expect(sockets[0].closeCalls).toHaveLength(1);

    // Run past the abandoned generation's whole probe cycle, interval and
    // deadline both, while its replacement is still being dialled. An
    // orphaned watchdog gets every chance to fire here.
    clock.advance(DEFAULT_PROBE_INTERVAL_MS + DEFAULT_PONG_DEADLINE_MS + 1);
    await flush();

    // The decisive assertion: the rotated-away socket is never probed again.
    expect(sockets[0].pings).toBe(0);
    expect(sockets).toHaveLength(2);
    expect(sockets[1].closeCalls).toHaveLength(0);

    // The replacement then opens and is probed on its own schedule.
    sockets[1].emitOpen();
    await flush();
    clock.advance(DEFAULT_PROBE_INTERVAL_MS);
    expect(sockets[1].pings).toBe(1);
    expect(sockets[1].closeCalls).toHaveLength(0);

    client.stop();
  });

  test("stop() leaves no timer able to resurrect the client", async () => {
    const { clock, sockets, client } = await startClient();
    sockets[0].emitOpen();
    await flush();

    client.stop();
    clock.advance(DEFAULT_PROBE_INTERVAL_MS * 10);
    await flush();

    expect(sockets).toHaveLength(1);
    expect(sockets[0].pings).toBe(0);
  });
});
