import { describe, expect, test } from "bun:test";

import type { DiscordInboundEvent } from "../channels/inbound-event.js";
import { RESUMABLE_CLOSE_CODE } from "./close-codes.js";
import {
  DiscordGatewayClient,
  type CancelTimer,
  type GatewaySocketLike,
} from "./gateway-socket.js";
import "../__tests__/test-preload.js";

const INTERVAL = 41_250;
/** First-beat jitter and backoff both use random = 0.5. */
const FIRST_BEAT_DELAY = INTERVAL / 2;
const FIRST_BACKOFF_DELAY = 500;

class FakeSocket implements GatewaySocketLike {
  sent: string[] = [];
  closed: { code?: number; reason?: string } | null = null;
  private listeners = new Map<
    string,
    Array<(event: { data?: unknown; code?: number }) => void>
  >();

  constructor(readonly url: string) {}

  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown; code?: number }) => void,
  ): void {
    const existing = this.listeners.get(type) ?? [];
    existing.push(listener);
    this.listeners.set(type, existing);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }

  /** Deliver a Gateway frame as Discord would. */
  message(payload: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(payload) });
    }
  }

  /** Fire a close event as a received (server/transport) close. */
  serverClose(code?: number): void {
    for (const listener of this.listeners.get("close") ?? []) {
      listener({ code });
    }
  }

  sentPayloads(): Array<{ op: number; d?: unknown }> {
    return this.sent.map((frame) => JSON.parse(frame));
  }
}

/** Timers under test control: nothing fires until the test says so. */
class ManualScheduler {
  private tasks: Array<{
    fn: () => void;
    delayMs: number;
    cancelled: boolean;
  }> = [];

  schedule = (fn: () => void, delayMs: number): CancelTimer => {
    const task = { fn, delayMs, cancelled: false };
    this.tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  };

  pendingDelays(): number[] {
    return this.tasks.filter((t) => !t.cancelled).map((t) => t.delayMs);
  }

  /** Run (and consume) the first pending task with exactly this delay. */
  run(delayMs: number): void {
    const index = this.tasks.findIndex(
      (t) => !t.cancelled && t.delayMs === delayMs,
    );
    if (index === -1) {
      throw new Error(
        `no pending task with delay ${delayMs}; pending: [${this.pendingDelays().join(", ")}]`,
      );
    }
    const [task] = this.tasks.splice(index, 1);
    task.fn();
  }
}

function harness(options: { allowed?: string[]; responses?: Response[] } = {}) {
  const sockets: FakeSocket[] = [];
  const scheduler = new ManualScheduler();
  const events: DiscordInboundEvent[] = [];
  const fetchCalls: Array<{ url: string; auth: string | undefined }> = [];
  let nowMs = 1_000_000;

  const defaultResponse = () =>
    new Response(
      JSON.stringify({
        url: "wss://gateway.test",
        session_start_limit: { remaining: 900, total: 1000 },
      }),
      { status: 200 },
    );
  const responses = options.responses ?? [];

  const client = new DiscordGatewayClient(
    {
      botToken: "token-abc",
      readAllowedChannelIds: () => new Set(options.allowed ?? ["channel-1"]),
      fetchFn: (async (url: string | URL | Request, init?: RequestInit) => {
        fetchCalls.push({
          url: String(url),
          auth: new Headers(init?.headers).get("Authorization") ?? undefined,
        });
        return responses.shift() ?? defaultResponse();
      }) as typeof fetch,
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      schedule: scheduler.schedule,
      random: () => 0.5,
      now: () => nowMs,
    },
    (event) => {
      events.push(event);
    },
  );

  return {
    client,
    sockets,
    scheduler,
    events,
    fetchCalls,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

type Harness = ReturnType<typeof harness>;

function hello(ws: FakeSocket): void {
  ws.message({ op: 10, d: { heartbeat_interval: INTERVAL } });
}

function ready(ws: FakeSocket): void {
  ws.message({
    op: 0,
    t: "READY",
    s: 1,
    d: {
      session_id: "sess-1",
      resume_gateway_url: "wss://resume.test",
      user: { id: "bot-1", username: "vellum" },
    },
  });
}

async function connectAndReady(h: Harness): Promise<FakeSocket> {
  await h.client.start();
  const ws = h.sockets[0];
  hello(ws);
  ready(ws);
  return ws;
}

function messageCreate(overrides: Record<string, unknown> = {}) {
  return {
    op: 0,
    t: "MESSAGE_CREATE",
    s: 2,
    d: {
      id: "msg-1",
      channel_id: "channel-1",
      guild_id: "guild-1",
      content: "<@bot-1> hello",
      author: { id: "user-1", username: "alice", global_name: "Alice" },
      mentions: [{ id: "bot-1" }],
      ...overrides,
    },
  };
}

describe("connect and identify", () => {
  test("fetches /gateway/bot with the bot token, then identifies after HELLO", async () => {
    const h = harness();
    await h.client.start();

    expect(h.fetchCalls).toHaveLength(1);
    expect(h.fetchCalls[0].url).toBe("https://discord.com/api/v10/gateway/bot");
    expect(h.fetchCalls[0].auth).toBe("Bot token-abc");

    // The socket carries the required v/encoding params.
    expect(h.sockets).toHaveLength(1);
    const ws = h.sockets[0];
    expect(ws.url).toBe("wss://gateway.test/?v=10&encoding=json");

    // Nothing is sent until HELLO arrives.
    expect(ws.sent).toHaveLength(0);
    hello(ws);
    const identify = ws.sentPayloads()[0] as {
      op: number;
      d: { token: string; intents: number };
    };
    expect(identify.op).toBe(2);
    expect(identify.d.token).toBe("token-abc");
    // GUILDS | GUILD_MESSAGES — the unprivileged bitmask, pinned in intents.ts.
    expect(identify.d.intents).toBe(513);
  });

  test("a transient REST failure retries and connects on success", async () => {
    const h = harness({
      responses: [new Response("", { status: 500 })],
    });
    await h.client.start();
    expect(h.sockets).toHaveLength(0);

    // Retry paced on the identify cap: window 1000ms, random 0.5 → 500ms.
    h.scheduler.run(FIRST_BACKOFF_DELAY);
    await Bun.sleep(0);
    expect(h.fetchCalls).toHaveLength(2);
    expect(h.sockets).toHaveLength(1);
  });

  test("a REST 401 latches the client — no socket, no retries", async () => {
    const h = harness({ responses: [new Response("", { status: 401 })] });
    await h.client.start();
    expect(h.sockets).toHaveLength(0);
    expect(h.scheduler.pendingDelays()).toEqual([]);
  });
});

describe("heartbeat loop", () => {
  test("beats on the jittered schedule with the last sequence, pausing on ACK", async () => {
    const h = harness();
    const ws = await connectAndReady(h);

    // First beat at random * interval.
    h.scheduler.run(FIRST_BEAT_DELAY);
    const beat = ws.sentPayloads().at(-1);
    expect(beat).toEqual({ op: 1, d: 1 });

    // ACK closes the window; the next tick beats again instead of killing.
    ws.message({ op: 11 });
    h.scheduler.run(INTERVAL);
    expect(ws.sentPayloads().filter((p) => p.op === 1)).toHaveLength(2);
    expect(ws.closed).toBeNull();
  });

  test("answers a server-requested heartbeat immediately", async () => {
    const h = harness();
    const ws = await connectAndReady(h);
    ws.message({ op: 1 });
    expect(ws.sentPayloads().at(-1)).toEqual({ op: 1, d: 1 });
  });

  test("a missed ACK kills the zombie with the resumable code and resumes", async () => {
    const h = harness();
    const ws = await connectAndReady(h);

    h.scheduler.run(FIRST_BEAT_DELAY);
    // No ACK arrives; the next tick declares the connection dead.
    h.scheduler.run(INTERVAL);
    expect(ws.closed?.code).toBe(RESUMABLE_CLOSE_CODE);

    // Recovery resumes: new socket on resume_gateway_url, op 6 after HELLO.
    h.scheduler.run(FIRST_BACKOFF_DELAY);
    const resumeWs = h.sockets[1];
    expect(resumeWs.url).toBe("wss://resume.test/?v=10&encoding=json");
    hello(resumeWs);
    expect(resumeWs.sentPayloads()[0]).toEqual({
      op: 6,
      d: { token: "token-abc", session_id: "sess-1", seq: 1 },
    });
  });

  test("a clock jump kills the connection without beating the dead socket", async () => {
    const h = harness();
    const ws = await connectAndReady(h);

    h.scheduler.run(FIRST_BEAT_DELAY);
    ws.message({ op: 11 });

    // The process was suspended: the next tick fires far past its interval.
    h.advance(INTERVAL * 3);
    h.scheduler.run(INTERVAL);
    expect(ws.closed?.code).toBe(RESUMABLE_CLOSE_CODE);
    // The kill pre-empted the beat — the ACK watchdog never opened a window.
    expect(ws.sentPayloads().filter((p) => p.op === 1)).toHaveLength(1);
    expect(h.scheduler.pendingDelays()).toContain(FIRST_BACKOFF_DELAY);
  });
});

describe("close-code dispatch", () => {
  test("an abnormal drop resumes on the resume URL", async () => {
    const h = harness();
    const ws = await connectAndReady(h);
    ws.serverClose(1006);

    h.scheduler.run(FIRST_BACKOFF_DELAY);
    const resumeWs = h.sockets[1];
    expect(resumeWs.url).toBe("wss://resume.test/?v=10&encoding=json");
    hello(resumeWs);
    expect(resumeWs.sentPayloads()[0]?.op).toBe(6);
  });

  test("a received 1000 resumes — received closes carry no invalidation", async () => {
    const h = harness();
    const ws = await connectAndReady(h);
    ws.serverClose(1000);

    h.scheduler.run(FIRST_BACKOFF_DELAY);
    const resumeWs = h.sockets[1];
    expect(resumeWs.url).toBe("wss://resume.test/?v=10&encoding=json");
    hello(resumeWs);
    expect(resumeWs.sentPayloads()[0]?.op).toBe(6);
  });

  test("a session-gone code identifies fresh on the base URL", async () => {
    const h = harness();
    const ws = await connectAndReady(h);
    ws.serverClose(4009);

    h.scheduler.run(FIRST_BACKOFF_DELAY);
    const identifyWs = h.sockets[1];
    expect(identifyWs.url).toBe("wss://gateway.test/?v=10&encoding=json");
    hello(identifyWs);
    expect(identifyWs.sentPayloads()[0]?.op).toBe(2);
  });

  test("a fatal close stops the client for good", async () => {
    const h = harness();
    const ws = await connectAndReady(h);
    ws.serverClose(4004);

    expect(h.scheduler.pendingDelays()).toEqual([]);
    expect(h.sockets).toHaveLength(1);
  });

  test("backoff widens across consecutive failures", async () => {
    const h = harness();
    const ws = await connectAndReady(h);
    ws.serverClose(1006);

    h.scheduler.run(FIRST_BACKOFF_DELAY);
    const second = h.sockets[1];
    second.serverClose(1006);
    // Second consecutive failure: window 2000ms, random 0.5 → 1000ms.
    expect(h.scheduler.pendingDelays()).toContain(1_000);
  });
});

describe("server-directed recovery", () => {
  test("op 7 RECONNECT kills the socket and resumes without waiting", async () => {
    const h = harness();
    const ws = await connectAndReady(h);
    ws.message({ op: 7 });

    expect(ws.closed?.code).toBe(RESUMABLE_CLOSE_CODE);
    h.scheduler.run(FIRST_BACKOFF_DELAY);
    const resumeWs = h.sockets[1];
    expect(resumeWs.url).toBe("wss://resume.test/?v=10&encoding=json");
    hello(resumeWs);
    expect(resumeWs.sentPayloads()[0]?.op).toBe(6);
  });

  test("op 9 d:false drops the session and re-identifies after the pacing delay", async () => {
    const h = harness();
    const ws = await connectAndReady(h);
    ws.message({ op: 9, d: false });

    expect(ws.closed?.code).toBe(RESUMABLE_CLOSE_CODE);
    // max(backoff 500ms, op 9 pacing 1000 + 0.5 * 4000 = 3000ms).
    h.scheduler.run(3_000);
    const identifyWs = h.sockets[1];
    expect(identifyWs.url).toBe("wss://gateway.test/?v=10&encoding=json");
    hello(identifyWs);
    expect(identifyWs.sentPayloads()[0]?.op).toBe(2);
  });

  test("op 9 d:true resumes", async () => {
    const h = harness();
    const ws = await connectAndReady(h);
    ws.message({ op: 9, d: true });

    h.scheduler.run(FIRST_BACKOFF_DELAY);
    const resumeWs = h.sockets[1];
    expect(resumeWs.url).toBe("wss://resume.test/?v=10&encoding=json");
    hello(resumeWs);
    expect(resumeWs.sentPayloads()[0]?.op).toBe(6);
  });
});

describe("message admission and normalization", () => {
  test("a mention in an allow-listed channel is emitted", async () => {
    const h = harness();
    const ws = await connectAndReady(h);
    ws.message(messageCreate());

    expect(h.events).toHaveLength(1);
    const event = h.events[0];
    expect(event.sourceChannel).toBe("discord");
    expect(event.message.conversationExternalId).toBe("channel-1");
    expect(event.actor.actorExternalId).toBe("user-1");
    expect(event.message.content).toBe("<@bot-1> hello");
  });

  test("non-mentions, other channels, and bot authors are dropped", async () => {
    const h = harness();
    const ws = await connectAndReady(h);

    ws.message(messageCreate({ mentions: [] }));
    ws.message(messageCreate({ channel_id: "channel-other" }));
    ws.message(messageCreate({ author: { id: "other-bot", bot: true } }));
    // The bot's own echo.
    ws.message(messageCreate({ author: { id: "bot-1" } }));
    expect(h.events).toHaveLength(0);
  });

  test("a thread message inherits its parent's allow-list entry", async () => {
    const h = harness();
    const ws = await connectAndReady(h);
    ws.message({
      op: 0,
      t: "GUILD_CREATE",
      s: 2,
      d: {
        id: "guild-1",
        threads: [{ id: "thread-9", type: 11, parent_id: "channel-1" }],
      },
    });
    ws.message(messageCreate({ channel_id: "thread-9" }));

    expect(h.events).toHaveLength(1);
    const event = h.events[0];
    expect(event.message.conversationExternalId).toBe("channel-1");
    expect(event.source.threadId).toBe("thread-9");
  });

  test("a THREAD_CREATE feeds later thread admission", async () => {
    const h = harness();
    const ws = await connectAndReady(h);
    ws.message({
      op: 0,
      t: "THREAD_CREATE",
      s: 2,
      d: { id: "thread-5", type: 11, parent_id: "channel-1" },
    });
    ws.message(messageCreate({ channel_id: "thread-5" }));
    expect(h.events).toHaveLength(1);
  });

  test("a thread in a non-listed channel stays out", async () => {
    const h = harness();
    const ws = await connectAndReady(h);
    ws.message({
      op: 0,
      t: "THREAD_CREATE",
      s: 2,
      d: { id: "thread-6", type: 11, parent_id: "channel-other" },
    });
    ws.message(messageCreate({ channel_id: "thread-6" }));
    expect(h.events).toHaveLength(0);
  });
});

describe("shutdown", () => {
  test("stop closes with 1000 and schedules nothing", async () => {
    const h = harness();
    const ws = await connectAndReady(h);
    h.client.stop();

    expect(ws.closed?.code).toBe(1000);
    expect(h.scheduler.pendingDelays()).toEqual([]);
    // A late close event from the torn-down socket must not revive anything.
    ws.serverClose(1000);
    expect(h.sockets).toHaveLength(1);
  });
});

describe("HELLO deadline", () => {
  const HELLO_DEADLINE = 30_000;

  test("a socket that never speaks is killed and recovery proceeds", async () => {
    const h = harness();
    await h.client.start();
    const ws = h.sockets[0];

    // No HELLO, no close event — the one state with no other watchdog.
    h.scheduler.run(HELLO_DEADLINE);
    expect(ws.closed?.code).toBe(RESUMABLE_CLOSE_CODE);

    // No session yet, so recovery identifies on the base URL.
    h.scheduler.run(FIRST_BACKOFF_DELAY);
    const retryWs = h.sockets[1];
    expect(retryWs.url).toBe("wss://gateway.test/?v=10&encoding=json");
    hello(retryWs);
    expect(retryWs.sentPayloads()[0]?.op).toBe(2);
  });

  test("HELLO disarms the deadline", async () => {
    const h = harness();
    await h.client.start();
    hello(h.sockets[0]);
    expect(h.scheduler.pendingDelays()).not.toContain(HELLO_DEADLINE);
  });

  test("a close before HELLO disarms the deadline for the dead socket", async () => {
    const h = harness();
    await h.client.start();
    h.sockets[0].serverClose(1006);
    expect(h.scheduler.pendingDelays()).not.toContain(HELLO_DEADLINE);
    // The reconnect arms a fresh deadline for the new socket.
    h.scheduler.run(FIRST_BACKOFF_DELAY);
    expect(h.sockets).toHaveLength(2);
    expect(h.scheduler.pendingDelays()).toContain(HELLO_DEADLINE);
  });
});
