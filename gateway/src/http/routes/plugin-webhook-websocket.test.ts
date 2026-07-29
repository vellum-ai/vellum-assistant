import { createHmac } from "node:crypto";

import { describe, expect, it } from "bun:test";

import "../../__tests__/test-preload.js";
import { initSigningKey } from "../../auth/token-service.js";
import type { PluginIngressResolution } from "../../channels/plugin-ingress-approvals.js";
import type { GatewayConfig } from "../../config.js";
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
  fetchImpl?: PluginWebhookSocketData["fetchImpl"],
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
    fetchImpl,
  };
}

/** Waits for the drain loop to settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe("frame delivery", () => {
  it("posts each frame to the plugin's route", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(async (url, init) => {
      calls.push({ url: String(url), body: init?.body });
      return new Response("", { status: 200 });
    });
    const { ws } = fakeSocket(data);

    handlers.message(ws, '{"event":"joined"}');
    await settle();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "http://runtime.test:7821/v1/x/plugins/meeting-bot/realtime",
    );
    expect(calls[0]!.body).toBe('{"event":"joined"}');
  });

  it("sends text frames as a raw content type, not application/json", async () => {
    // The runtime adapter parses application/json and keeps only objects, so
    // a bare string or malformed frame would reach the plugin as an empty
    // body. Text frames must arrive exactly as sent.
    const seen: { body: unknown; contentType: string }[] = [];
    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      seen.push({ body: init?.body, contentType: headers["content-type"]! });
      return new Response("", { status: 200 });
    });
    const { ws } = fakeSocket(data);

    handlers.message(ws, "not json at all");
    await settle();

    expect(seen[0]!.contentType).not.toContain("application/json");
    expect(seen[0]!.body).toBe("not json at all");
  });

  it("sends binary frames as octet-stream", async () => {
    const seen: { body: unknown; contentType: string }[] = [];
    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      seen.push({ body: init?.body, contentType: headers["content-type"]! });
      return new Response("", { status: 200 });
    });
    const { ws } = fakeSocket(data);

    handlers.message(ws, new Uint8Array([1, 2, 3]).buffer);
    await settle();

    expect(seen[0]!.contentType).toBe("application/octet-stream");
    expect(seen[0]!.body).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("delivers frames one at a time, in order", async () => {
    // The ordering guarantee: the plugin must see `joined` before `left`,
    // which a fan-out of concurrent POSTs would not promise.
    const started: string[] = [];
    const finished: string[] = [];
    let release: (() => void) | undefined;

    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(async (_url, init) => {
      const body = String(init?.body);
      started.push(body);
      if (body === "first") {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      finished.push(body);
      return new Response("", { status: 200 });
    });
    const { ws } = fakeSocket(data);

    handlers.message(ws, "first");
    handlers.message(ws, "second");
    await settle();

    // Second must not have started while first is still in flight.
    expect(started).toEqual(["first"]);
    release?.();
    await settle();
    expect(started).toEqual(["first", "second"]);
    expect(finished).toEqual(["first", "second"]);
  });

  it("keeps delivering after a frame fails", async () => {
    // A failed POST is skipped, not retried — retrying would reorder it
    // behind frames that already arrived.
    const seen: string[] = [];
    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(async (_url, init) => {
      const body = String(init?.body);
      seen.push(body);
      if (body === "boom") throw new Error("upstream down");
      return new Response("", { status: 200 });
    });
    const { ws } = fakeSocket(data);

    handlers.message(ws, "boom");
    handlers.message(ws, "after");
    await settle();

    expect(seen).toEqual(["boom", "after"]);
  });

  it("closes a connection that outruns the buffer", async () => {
    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(
      async () =>
        new Promise<Response>(() => {
          /* never settles, so the queue backs up */
        }),
    );
    const { ws, closes } = fakeSocket(data);

    for (let i = 0; i < 150; i++) handlers.message(ws, `frame-${i}`);

    expect(closes).toHaveLength(1);
    expect(closes[0]!.code).toBe(1008);
  });

  it("refuses a single frame larger than the webhook payload cap", async () => {
    // It could never be delivered anyway — the plugin route would reject it
    // as an oversized webhook body.
    const seen: string[] = [];
    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(async (_url, init) => {
      seen.push(String(init?.body));
      return new Response("", { status: 200 });
    });
    const { ws, closes } = fakeSocket(data);

    handlers.message(ws, "x".repeat(2048));
    await settle();

    expect(closes).toHaveLength(1);
    expect(closes[0]!.code).toBe(1008);
    expect(seen).toEqual([]);
  });

  it("bounds the queue by bytes, not just frame count", async () => {
    // 100 frames of Bun's maximum size would be gigabytes, so the count
    // alone is not a memory bound.
    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(
      async () =>
        new Promise<Response>(() => {
          /* never settles, so the queue backs up */
        }),
    );
    const { ws, closes } = fakeSocket(data);

    // Each frame is under the per-frame cap, and there are fewer than
    // MAX_PENDING_FRAMES of them — only the byte budget can reject these.
    for (let i = 0; i < 20; i++) handlers.message(ws, "x".repeat(1000));

    expect(closes).toHaveLength(1);
    expect(closes[0]!.code).toBe(1008);
    expect(data.queuedBytes).toBe(0);
  });

  it("releases queued bytes as frames are delivered", async () => {
    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(async () => new Response("", { status: 200 }));
    const { ws } = fakeSocket(data);

    handlers.message(ws, "x".repeat(100));
    handlers.message(ws, "x".repeat(100));
    await settle();

    expect(data.queue).toEqual([]);
    expect(data.queuedBytes).toBe(0);
  });

  it("drops undelivered frames when the caller goes away", async () => {
    const seen: string[] = [];
    const handlers = getPluginWebhookWebsocketHandlers();
    let release: (() => void) | undefined;
    const data = socketData(async (_url, init) => {
      seen.push(String(init?.body));
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response("", { status: 200 });
    });
    const { ws } = fakeSocket(data);

    handlers.message(ws, "first");
    handlers.message(ws, "second");
    await settle();
    handlers.close(ws, 1000, "done");
    release?.();
    await settle();

    // `second` was still queued when the socket closed, so it never ships.
    expect(seen).toEqual(["first"]);
    expect(data.queue).toEqual([]);
  });

  it("ignores frames that arrive after close", async () => {
    const seen: string[] = [];
    const handlers = getPluginWebhookWebsocketHandlers();
    const data = socketData(async (_url, init) => {
      seen.push(String(init?.body));
      return new Response("", { status: 200 });
    });
    const { ws } = fakeSocket(data);

    handlers.close(ws, 1000, "done");
    handlers.message(ws, "late");
    await settle();

    expect(seen).toEqual([]);
  });
});
