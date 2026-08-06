import { createHmac } from "node:crypto";

import { describe, expect, it } from "bun:test";

import "../../__tests__/test-preload.js";
import { initSigningKey } from "../../auth/token-service.js";
import type { PluginIngressResolution } from "../../channels/plugin-ingress-approvals.js";
import type { GatewayConfig } from "../../config.js";
import { signHandshakeUrl } from "../plugin-ingress-handshake.js";
import {
  createPluginWebhookWebsocketHandler,
  getPluginWebhookWebsocketHandlers,
  isPluginWebhookSocketData,
  type PluginWebhookSocketData,
} from "./plugin-webhook-websocket.js";

initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long"));

const CONFIG = {
  assistantRuntimeBaseUrl: "http://runtime.test:7821",
  runtimeTimeoutMs: 1000,
  maxWebhookPayloadBytes: 1024,
} as GatewayConfig;

const PLUGIN_SECRET = "plugin-webhook-secret";
const VELLUM_SECRET = "platform-webhook-secret";
const WS_PATH = "/webhooks/plugins/meeting-bot/realtime";

const ROUTE = {
  path: "realtime",
  kind: "websocket" as const,
  signer: "plugin" as const,
  handshake: "signed-headers" as const,
  description: "events",
};

function credentialsFor(entries: Record<string, string>) {
  return {
    get: async (key: string) => entries[key],
  } as unknown as Parameters<
    typeof createPluginWebhookWebsocketHandler
  >[0]["credentials"];
}

const CREDENTIALS = credentialsFor({
  "credential/meeting-bot/webhook_secret": PLUGIN_SECRET,
  "credential/vellum/webhook_secret": VELLUM_SECRET,
});

function resolution(
  overrides: Partial<PluginIngressResolution> = {},
): PluginIngressResolution {
  return { approved: [], pending: [], problems: [], ...overrides };
}

function approvedWith(
  routes: {
    path: string;
    kind: "http" | "websocket";
    signer: "plugin" | "vellum";
    handshake: "signed-headers" | "signed-query";
    description: string;
  }[],
): PluginIngressResolution {
  return resolution({
    approved: [{ plugin: "meeting-bot", routes, digest: "d".repeat(32) }],
  });
}

/** A signed upgrade request. */
function upgradeRequest(
  opts: {
    secret?: string;
    timestamp?: string;
    path?: string;
    upgrade?: boolean;
    signPath?: string;
  } = {},
): Request {
  const {
    secret = PLUGIN_SECRET,
    timestamp = String(Math.floor(Date.now() / 1000)),
    path = WS_PATH,
    upgrade = true,
    signPath = path,
  } = opts;
  const headers: Record<string, string> = {};
  if (upgrade) headers.upgrade = "websocket";
  if (timestamp) headers["vellum-timestamp"] = timestamp;
  if (secret) {
    headers["vellum-signature"] =
      `sha256=${createHmac("sha256", secret).update(`${timestamp}.${signPath}`, "utf8").digest("hex")}`;
  }
  return new Request(`http://gateway${path}`, { headers });
}

/** A Bun server stand-in that records whether an upgrade was accepted. */
function fakeServer(accept = true) {
  const upgrades: PluginWebhookSocketData[] = [];
  const server = {
    upgrade: (_req: Request, opts: { data: PluginWebhookSocketData }) => {
      if (!accept) return false;
      upgrades.push(opts.data);
      return true;
    },
  } as unknown as import("bun").Server<unknown>;
  return { server, upgrades };
}

function makeHandler(
  overrides: {
    resolve?: () => PluginIngressResolution;
    credentials?: ReturnType<typeof credentialsFor>;
  } = {},
) {
  return createPluginWebhookWebsocketHandler({
    config: CONFIG,
    resolve: overrides.resolve ?? (() => approvedWith([ROUTE])),
    credentials: overrides.credentials ?? CREDENTIALS,
  });
}

describe("upgrade gate", () => {
  it("upgrades an approved, signed websocket route", async () => {
    const handle = makeHandler();
    const { server, upgrades } = fakeServer();

    const res = await handle(
      upgradeRequest(),
      server,
      "meeting-bot",
      "realtime",
    );

    expect(res).toBeUndefined();
    expect(upgrades).toHaveLength(1);
    expect(upgrades[0]!.plugin).toBe("meeting-bot");
    expect(isPluginWebhookSocketData(upgrades[0])).toBe(true);
  });

  it("refuses a non-upgrade request", async () => {
    const handle = makeHandler();
    const { server, upgrades } = fakeServer();

    const res = await handle(
      upgradeRequest({ upgrade: false }),
      server,
      "meeting-bot",
      "realtime",
    );

    expect(res?.status).toBe(426);
    expect(upgrades).toEqual([]);
  });

  it("404s a declaration nobody approved", async () => {
    const handle = makeHandler({
      resolve: () =>
        resolution({
          pending: [
            { plugin: "meeting-bot", routes: [ROUTE], digest: "d".repeat(32) },
          ],
        }),
    });
    const { server, upgrades } = fakeServer();

    const res = await handle(
      upgradeRequest(),
      server,
      "meeting-bot",
      "realtime",
    );

    expect(res?.status).toBe(404);
    expect(upgrades).toEqual([]);
  });

  it("upgrades a vellum-signed declaration nobody approved", async () => {
    // Only a caller holding the platform secret can open it, and the user
    // extended that trust when they connected their account.
    const handle = makeHandler({
      resolve: () =>
        resolution({
          pending: [
            {
              plugin: "meeting-bot",
              routes: [{ ...ROUTE, signer: "vellum" as const }],
              digest: "d".repeat(32),
            },
          ],
        }),
    });
    const { server, upgrades } = fakeServer();

    const res = await handle(
      upgradeRequest({ secret: VELLUM_SECRET }),
      server,
      "meeting-bot",
      "realtime",
    );

    expect(res).toBeUndefined();
    expect(upgrades).toHaveLength(1);
  });

  it("still demands the platform signature on an unapproved vellum route", async () => {
    // Skipping approval did not skip authentication.
    const handle = makeHandler({
      resolve: () =>
        resolution({
          pending: [
            {
              plugin: "meeting-bot",
              routes: [{ ...ROUTE, signer: "vellum" as const }],
              digest: "d".repeat(32),
            },
          ],
        }),
    });
    const { server, upgrades } = fakeServer();

    const res = await handle(
      upgradeRequest({ secret: PLUGIN_SECRET }),
      server,
      "meeting-bot",
      "realtime",
    );

    expect(res?.status).toBe(403);
    expect(upgrades).toEqual([]);
  });

  it("404s an http-kind route rather than upgrading it", async () => {
    // Approving an HTTP route did not approve a socket at that path.
    const handle = makeHandler({
      resolve: () => approvedWith([{ ...ROUTE, kind: "http" as const }]),
    });
    const { server, upgrades } = fakeServer();

    const res = await handle(
      upgradeRequest(),
      server,
      "meeting-bot",
      "realtime",
    );

    expect(res?.status).toBe(404);
    expect(upgrades).toEqual([]);
  });

  it("404s a path the declaration does not name", async () => {
    const handle = makeHandler();
    const { server, upgrades } = fakeServer();

    const res = await handle(
      upgradeRequest({ path: "/webhooks/plugins/meeting-bot/admin" }),
      server,
      "meeting-bot",
      "admin",
    );

    expect(res?.status).toBe(404);
    expect(upgrades).toEqual([]);
  });

  it("fails closed when the approved set cannot be resolved", async () => {
    const handle = makeHandler({
      resolve: () => {
        throw new Error("db unavailable");
      },
    });
    const { server, upgrades } = fakeServer();

    const res = await handle(
      upgradeRequest(),
      server,
      "meeting-bot",
      "realtime",
    );

    expect(res?.status).toBe(500);
    expect(upgrades).toEqual([]);
  });
});

describe("handshake signature", () => {
  it("refuses an unsigned handshake", async () => {
    const handle = makeHandler();
    const { server, upgrades } = fakeServer();

    const res = await handle(
      upgradeRequest({ secret: "" }),
      server,
      "meeting-bot",
      "realtime",
    );

    expect(res?.status).toBe(403);
    expect(upgrades).toEqual([]);
  });

  it("refuses a handshake signed with the wrong secret", async () => {
    const handle = makeHandler();
    const { server, upgrades } = fakeServer();

    const res = await handle(
      upgradeRequest({ secret: "nope" }),
      server,
      "meeting-bot",
      "realtime",
    );

    expect(res?.status).toBe(403);
    expect(upgrades).toEqual([]);
  });

  it("refuses a stale handshake", async () => {
    // The timestamp is what stops a captured handshake working forever.
    const handle = makeHandler();
    const { server, upgrades } = fakeServer();

    const res = await handle(
      upgradeRequest({
        timestamp: String(Math.floor(Date.now() / 1000) - 3600),
      }),
      server,
      "meeting-bot",
      "realtime",
    );

    expect(res?.status).toBe(403);
    expect(upgrades).toEqual([]);
  });

  it("refuses a handshake with no timestamp at all", async () => {
    const handle = makeHandler();
    const { server, upgrades } = fakeServer();

    const res = await handle(
      upgradeRequest({ timestamp: "" }),
      server,
      "meeting-bot",
      "realtime",
    );

    expect(res?.status).toBe(403);
    expect(upgrades).toEqual([]);
  });

  it("refuses a signature minted for a different path", async () => {
    // Binding the path stops a handshake for one route opening another.
    const handle = makeHandler();
    const { server, upgrades } = fakeServer();

    const res = await handle(
      upgradeRequest({ signPath: "/webhooks/plugins/meeting-bot/other" }),
      server,
      "meeting-bot",
      "realtime",
    );

    expect(res?.status).toBe(403);
    expect(upgrades).toEqual([]);
  });

  it("refuses the upgrade when no secret is configured", async () => {
    const handle = makeHandler({ credentials: credentialsFor({}) });
    const { server, upgrades } = fakeServer();

    const res = await handle(
      upgradeRequest(),
      server,
      "meeting-bot",
      "realtime",
    );

    expect(res?.status).toBe(409);
    expect(upgrades).toEqual([]);
  });

  it("verifies a vellum-signed route against the platform secret", async () => {
    const handle = makeHandler({
      resolve: () => approvedWith([{ ...ROUTE, signer: "vellum" as const }]),
    });
    const { server, upgrades } = fakeServer();

    expect(
      await handle(
        upgradeRequest({ secret: VELLUM_SECRET }),
        server,
        "meeting-bot",
        "realtime",
      ),
    ).toBeUndefined();
    expect(upgrades).toHaveLength(1);

    const rejected = await handle(
      upgradeRequest({ secret: PLUGIN_SECRET }),
      server,
      "meeting-bot",
      "realtime",
    );
    expect(rejected?.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Signed-query handshake
// ---------------------------------------------------------------------------

const QUERY_ROUTE = { ...ROUTE, handshake: "signed-query" as const };

/** An upgrade request whose whole credential is in the URL. */
function signedQueryRequest(
  opts: { secret?: string; ttlSeconds?: number; path?: string } = {},
): Request {
  const { secret = PLUGIN_SECRET, ttlSeconds = 3600, path = WS_PATH } = opts;
  const url = signHandshakeUrl({
    url: new URL(`http://gateway${path}`),
    secret,
    ttlSeconds,
  });
  return new Request(url.toString(), { headers: { upgrade: "websocket" } });
}

describe("signed-query handshake", () => {
  it("upgrades a route that declares it, with no headers at all", async () => {
    // The point of the scheme: Recall is handed a URL and dials it. If this
    // needed a header, the caller could not comply.
    const handle = makeHandler({ resolve: () => approvedWith([QUERY_ROUTE]) });
    const { server, upgrades } = fakeServer();

    const res = await handle(
      signedQueryRequest(),
      server,
      "meeting-bot",
      "realtime",
    );

    expect(res).toBeUndefined();
    expect(upgrades).toHaveLength(1);
  });

  it("refuses a URL whose expiry has passed", async () => {
    const handle = makeHandler({ resolve: () => approvedWith([QUERY_ROUTE]) });
    const { server, upgrades } = fakeServer();
    const url = signHandshakeUrl({
      url: new URL(`http://gateway${WS_PATH}`),
      secret: PLUGIN_SECRET,
      ttlSeconds: 60,
      nowMs: Date.now() - 120_000,
    });

    const res = await handle(
      new Request(url.toString(), { headers: { upgrade: "websocket" } }),
      server,
      "meeting-bot",
      "realtime",
    );

    expect(res?.status).toBe(403);
    expect(upgrades).toEqual([]);
  });

  it("refuses a URL signed with the wrong secret", async () => {
    const handle = makeHandler({ resolve: () => approvedWith([QUERY_ROUTE]) });
    const { server, upgrades } = fakeServer();

    const res = await handle(
      signedQueryRequest({ secret: "not-the-plugin-secret" }),
      server,
      "meeting-bot",
      "realtime",
    );

    expect(res?.status).toBe(403);
    expect(upgrades).toEqual([]);
  });

  it("does not accept a signed URL on a route declaring signed-headers", async () => {
    // The declaration selects the scheme. A route a guardian approved as
    // header-signed must not also open to a URL-borne credential, or the
    // handshake field would be advisory rather than binding.
    const handle = makeHandler({ resolve: () => approvedWith([ROUTE]) });
    const { server, upgrades } = fakeServer();

    const res = await handle(
      signedQueryRequest(),
      server,
      "meeting-bot",
      "realtime",
    );

    expect(res?.status).toBe(403);
    expect(upgrades).toEqual([]);
  });

  it("does not accept header signing on a route declaring signed-query", async () => {
    // And the converse, so the two cannot be mixed in either direction.
    const handle = makeHandler({ resolve: () => approvedWith([QUERY_ROUTE]) });
    const { server, upgrades } = fakeServer();

    const res = await handle(
      upgradeRequest({ secret: PLUGIN_SECRET }),
      server,
      "meeting-bot",
      "realtime",
    );

    expect(res?.status).toBe(403);
    expect(upgrades).toEqual([]);
  });

  it("still requires the upgrade header", async () => {
    const handle = makeHandler({ resolve: () => approvedWith([QUERY_ROUTE]) });
    const { server } = fakeServer();
    const url = signHandshakeUrl({
      url: new URL(`http://gateway${WS_PATH}`),
      secret: PLUGIN_SECRET,
      ttlSeconds: 3600,
    });

    const res = await handle(
      new Request(url.toString()),
      server,
      "meeting-bot",
      "realtime",
    );

    expect(res?.status).toBe(426);
  });
});

// ---------------------------------------------------------------------------
// Frame delivery
// ---------------------------------------------------------------------------

/** Socket stand-in capturing close calls. */
function fakeSocket(data: PluginWebhookSocketData) {
  const closes: { code: number; reason: string }[] = [];
  const ws = {
    data,
    close: (code: number, reason: string) => closes.push({ code, reason }),
  } as unknown as import("bun").ServerWebSocket<PluginWebhookSocketData>;
  return { ws, closes };
}

function socketData(
  ipcCall?: PluginWebhookSocketData["ipcCall"],
): PluginWebhookSocketData {
  return {
    wsType: "plugin-webhook",
    config: CONFIG,
    plugin: "meeting-bot",
    path: "realtime",
    queue: [],
    queuedBytes: 0,
    delivering: false,
    closed: false,
    ipcCall,
  };
}

/** Waits for the drain loop to settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** A frame carrying `value`, as the caller would send it. */
function evt(value: string): string {
  return JSON.stringify({ event: value });
}

describe("frame delivery", () => {
  it("hands each frame to the plugin's route over IPC", async () => {
    const calls: {
      method: string;
      params?: Record<string, unknown>;
      binary?: Uint8Array;
    }[] = [];
    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(async (method, params, opts) => {
      calls.push({ method, params, binary: opts?.binary });
      return null;
    });
    const { ws } = fakeSocket(data);

    handlers.message(ws, evt("joined"));
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("user_route_post");
    expect(calls[0]!.params).toMatchObject({
      pathParams: { path: "plugins/meeting-bot/realtime" },
    });
    // The frame travels as the raw body, byte-for-byte.
    expect(new TextDecoder().decode(calls[0]!.binary)).toBe(evt("joined"));
  });

  it("delivers a frame that is not JSON at all, unchanged", async () => {
    // The transport does not decide what a frame means. Anything the caller
    // sent reaches the plugin as the bytes it sent.
    const seen: string[] = [];
    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(async (_method, _params, opts) => {
      seen.push(new TextDecoder().decode(opts?.binary));
      return null;
    });
    const { ws, closes } = fakeSocket(data);

    for (const frame of ["not json", '"a bare string"', "42", "[1,2,3]"]) {
      handlers.message(ws, frame);
    }
    await settle();

    expect(seen).toEqual(["not json", '"a bare string"', "42", "[1,2,3]"]);
    expect(closes).toEqual([]);
  });

  it("delivers a binary frame as the same bytes", async () => {
    const seen: Uint8Array[] = [];
    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(async (_method, _params, opts) => {
      seen.push(opts!.binary!);
      return null;
    });
    const { ws, closes } = fakeSocket(data);

    handlers.message(ws, new Uint8Array([0, 255, 10, 123]).buffer);
    await settle();

    expect(seen).toEqual([new Uint8Array([0, 255, 10, 123])]);
    expect(closes).toEqual([]);
  });

  it("delivers frames one at a time, in order", async () => {
    // The ordering guarantee: the plugin must see `joined` before `left`,
    // which a fan-out of concurrent calls would not promise.
    const started: string[] = [];
    const finished: string[] = [];
    let release: (() => void) | undefined;

    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(async (_method, _params, opts) => {
      const event = JSON.parse(new TextDecoder().decode(opts?.binary)).event;
      started.push(event);
      if (event === "first") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      finished.push(event);
      return null;
    });
    const { ws } = fakeSocket(data);

    handlers.message(ws, evt("first"));
    handlers.message(ws, evt("second"));
    await settle();

    // Second must not have started while first is still in flight.
    expect(started).toEqual(["first"]);
    release?.();
    await settle();
    expect(started).toEqual(["first", "second"]);
    expect(finished).toEqual(["first", "second"]);
  });

  it("keeps delivering after a frame fails", async () => {
    // A failed call is skipped, not retried — retrying would reorder it
    // behind frames that already arrived.
    const seen: string[] = [];
    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(async (_method, _params, opts) => {
      const event = JSON.parse(new TextDecoder().decode(opts?.binary)).event;
      seen.push(event);
      if (event === "boom") throw new Error("assistant unreachable");
      return null;
    });
    const { ws } = fakeSocket(data);

    handlers.message(ws, evt("boom"));
    handlers.message(ws, evt("after"));
    await settle();

    expect(seen).toEqual(["boom", "after"]);
  });

  it("refuses a single frame larger than the webhook payload cap", async () => {
    const calls: unknown[] = [];
    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(async (method) => {
      calls.push(method);
      return null;
    });
    const { ws, closes } = fakeSocket(data);

    handlers.message(ws, JSON.stringify({ event: "x".repeat(2048) }));
    await settle();

    expect(closes).toHaveLength(1);
    expect(closes[0]!.code).toBe(1009);
    expect(calls).toEqual([]);
  });

  it("bounds the queue by bytes, not just frame count", async () => {
    // 100 frames of Bun's maximum size would be gigabytes, so the count
    // alone is not a memory bound.
    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(
      async () =>
        new Promise<unknown>(() => {
          /* never settles, so the queue backs up */
        }),
    );
    const { ws, closes } = fakeSocket(data);

    // Each frame is under the per-frame cap, and there are fewer than
    // MAX_PENDING_FRAMES of them — only the byte budget can reject these.
    for (let i = 0; i < 20; i++) {
      handlers.message(ws, JSON.stringify({ event: "x".repeat(900) }));
    }

    expect(closes).toHaveLength(1);
    expect(closes[0]!.code).toBe(1008);
    expect(data.queuedBytes).toBe(0);
  });

  it("closes a connection that outruns the buffer", async () => {
    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(
      async () =>
        new Promise<unknown>(() => {
          /* never settles */
        }),
    );
    const { ws, closes } = fakeSocket(data);

    for (let i = 0; i < 150; i++) handlers.message(ws, evt(`frame-${i}`));

    expect(closes).toHaveLength(1);
    expect(closes[0]!.code).toBe(1008);
  });

  it("releases queued bytes as frames are delivered", async () => {
    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(async () => null);
    const { ws } = fakeSocket(data);

    handlers.message(ws, evt("one"));
    handlers.message(ws, evt("two"));
    await settle();

    expect(data.queue).toEqual([]);
    expect(data.queuedBytes).toBe(0);
  });

  it("drops undelivered frames when the caller goes away", async () => {
    const seen: string[] = [];
    const handlers = getPluginWebhookWebsocketHandlers();
    let release: (() => void) | undefined;
    const data = socketData(async (_method, _params, opts) => {
      seen.push(JSON.parse(new TextDecoder().decode(opts?.binary)).event);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return null;
    });
    const { ws } = fakeSocket(data);

    handlers.message(ws, evt("first"));
    handlers.message(ws, evt("second"));
    await settle();
    handlers.close(ws, 1000, "done");
    release?.();
    await settle();

    // `second` was still queued when the socket closed, so it never ships.
    expect(seen).toEqual(["first"]);
    expect(data.queue).toEqual([]);
  });

  it("ignores frames that arrive after close", async () => {
    const seen: unknown[] = [];
    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(async (method) => {
      seen.push(method);
      return null;
    });
    const { ws } = fakeSocket(data);

    handlers.close(ws, 1000, "done");
    handlers.message(ws, evt("late"));
    await settle();

    expect(seen).toEqual([]);
  });
});
