import { createHmac } from "node:crypto";

import { describe, expect, it } from "bun:test";

import "../../__tests__/test-preload.js";
import { initSigningKey } from "../../auth/token-service.js";
import type { PluginIngressResolution } from "../../channels/plugin-ingress-approvals.js";
import type { GatewayConfig } from "../../config.js";
import { createPluginWebhookHandler } from "./plugin-webhook.js";

// The handler mints a real service token for the upstream hop. Initialising
// the key beats mocking token-exchange, which is process-wide in bun and
// would leak into every other suite in the run.
initSigningKey(Buffer.from("test-signing-key-at-least-32-bytes-long"));

const CONFIG = {
  assistantRuntimeBaseUrl: "http://runtime.test:7821",
  runtimeTimeoutMs: 1000,
  maxWebhookPayloadBytes: 1024,
} as GatewayConfig;

const ROUTE = {
  path: "realtime",
  kind: "http" as const,
  signer: "plugin" as const,
  description: "events",
};

const PLUGIN_SECRET = "plugin-webhook-secret";
const VELLUM_SECRET = "platform-webhook-secret";

/** Stands in for the credential cache, holding secrets by key. */
function credentialsFor(entries: Record<string, string>) {
  return {
    get: async (key: string) => entries[key],
  } as unknown as Parameters<
    typeof createPluginWebhookHandler
  >[0]["credentials"];
}

const CREDENTIALS = credentialsFor({
  "credential/meeting-bot/webhook_secret": PLUGIN_SECRET,
  "credential/vellum/webhook_secret": VELLUM_SECRET,
});

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function resolution(
  overrides: Partial<PluginIngressResolution> = {},
): PluginIngressResolution {
  return { approved: [], pending: [], problems: [], ...overrides };
}

/** An approved declaration for `meeting-bot` carrying `routes`. */
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

/** Records the upstream call and answers 200. */
function recordingFetch() {
  const calls: { url: string; method: string; body: string }[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body:
        init?.body instanceof ArrayBuffer
          ? new TextDecoder().decode(init.body)
          : "",
    });
    return new Response("ok", { status: 200 });
  };
  return { calls, fetchImpl };
}

/** A signed POST. Pass `secret` to sign with something else, or "" for none. */
function post(path: string, body = "{}", secret = PLUGIN_SECRET): Request {
  return new Request(`http://gateway${path}`, {
    method: "POST",
    body,
    headers: secret ? { "vellum-signature": sign(body, secret) } : {},
  });
}

describe("approved routes", () => {
  it("forwards to the plugin's route namespace on the runtime", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () => approvedWith([ROUTE]),
      fetchImpl,
    });

    const res = await handle(
      post("/webhooks/plugins/meeting-bot/realtime", '{"event":"joined"}'),
      "meeting-bot",
      "realtime",
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "http://runtime.test:7821/v1/x/plugins/meeting-bot/realtime",
    );
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toBe('{"event":"joined"}');
  });

  it("carries the query string through", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () => approvedWith([ROUTE]),
      fetchImpl,
    });

    await handle(
      post("/webhooks/plugins/meeting-bot/realtime?token=abc"),
      "meeting-bot",
      "realtime",
    );

    expect(calls[0]!.url).toContain("?token=abc");
  });
});

describe("the gate", () => {
  it("404s a route the plugin declares but nobody approved", async () => {
    // The whole point of the gate: pending is not served.
    const { calls, fetchImpl } = recordingFetch();
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () =>
        resolution({
          pending: [
            { plugin: "meeting-bot", routes: [ROUTE], digest: "d".repeat(32) },
          ],
        }),
      fetchImpl,
    });

    const res = await handle(
      post("/webhooks/plugins/meeting-bot/realtime"),
      "meeting-bot",
      "realtime",
    );

    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("404s a plugin with no declaration at all", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () => approvedWith([ROUTE]),
      fetchImpl,
    });

    const res = await handle(
      post("/webhooks/plugins/other/realtime"),
      "other",
      "realtime",
    );

    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("does not let one plugin's approval serve another's path", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () => approvedWith([ROUTE]),
      fetchImpl,
    });

    const res = await handle(
      post("/webhooks/plugins/evil/realtime"),
      "evil",
      "realtime",
    );

    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("404s a path the approved declaration does not name", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () => approvedWith([ROUTE]),
      fetchImpl,
    });

    const res = await handle(
      post("/webhooks/plugins/meeting-bot/admin"),
      "meeting-bot",
      "admin",
    );

    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("matches exactly, so an approved path does not carry its subtree", async () => {
    // Approving `realtime` approved that path, not everything beneath it.
    const { calls, fetchImpl } = recordingFetch();
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () => approvedWith([ROUTE]),
      fetchImpl,
    });

    for (const path of [
      "realtime/extra",
      "realtime/../../secret",
      "realtime%2fextra",
      "REALTIME",
      "realtime/",
    ]) {
      const res = await handle(
        post(`/webhooks/plugins/meeting-bot/${path}`),
        "meeting-bot",
        path,
      );
      expect(res.status).toBe(404);
    }
    expect(calls).toEqual([]);
  });

  it("refuses to serve a websocket-kind route over plain HTTP", async () => {
    // Approving a WebSocket route did not approve an HTTP one at that path.
    const { calls, fetchImpl } = recordingFetch();
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () => approvedWith([{ ...ROUTE, kind: "websocket" as const }]),
      fetchImpl,
    });

    const res = await handle(
      post("/webhooks/plugins/meeting-bot/realtime"),
      "meeting-bot",
      "realtime",
    );

    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("fails closed when the approved set cannot be resolved", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () => {
        throw new Error("db unavailable");
      },
      fetchImpl,
    });

    const res = await handle(
      post("/webhooks/plugins/meeting-bot/realtime"),
      "meeting-bot",
      "realtime",
    );

    expect(res.status).toBe(500);
    expect(calls).toEqual([]);
  });
});

describe("signature verification", () => {
  it("rejects an unsigned request", async () => {
    // Approval decides which paths exist; it does not say who may call them.
    const { calls, fetchImpl } = recordingFetch();
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () => approvedWith([ROUTE]),
      fetchImpl,
    });

    const res = await handle(
      post("/webhooks/plugins/meeting-bot/realtime", "{}", ""),
      "meeting-bot",
      "realtime",
    );

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("rejects a signature made with the wrong secret", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () => approvedWith([ROUTE]),
      fetchImpl,
    });

    const res = await handle(
      post("/webhooks/plugins/meeting-bot/realtime", "{}", "not-the-secret"),
      "meeting-bot",
      "realtime",
    );

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("rejects a signature that does not cover this body", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () => approvedWith([ROUTE]),
      fetchImpl,
    });

    const tampered = new Request(
      "http://gateway/webhooks/plugins/meeting-bot/realtime",
      {
        method: "POST",
        body: '{"event":"tampered"}',
        headers: {
          "vellum-signature": sign('{"event":"joined"}', PLUGIN_SECRET),
        },
      },
    );

    const res = await handle(tampered, "meeting-bot", "realtime");

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("refuses to serve the route at all when no secret is configured", async () => {
    // Fail closed: a missing secret is a setup mistake, and treating it as
    // "no signature required" would turn it into an open public endpoint.
    const { calls, fetchImpl } = recordingFetch();
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: credentialsFor({}),
      resolve: () => approvedWith([ROUTE]),
      fetchImpl,
    });

    const res = await handle(
      post("/webhooks/plugins/meeting-bot/realtime"),
      "meeting-bot",
      "realtime",
    );

    expect(res.status).toBe(409);
    expect(calls).toEqual([]);
  });

  it("verifies a vellum-signed route against the platform secret", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () => approvedWith([{ ...ROUTE, signer: "vellum" as const }]),
      fetchImpl,
    });

    const res = await handle(
      post("/webhooks/plugins/meeting-bot/realtime", "{}", VELLUM_SECRET),
      "meeting-bot",
      "realtime",
    );

    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("does not accept the plugin's own secret on a vellum-signed route", async () => {
    // Otherwise declaring `signer: "vellum"` would widen rather than narrow
    // who can reach the route.
    const { calls, fetchImpl } = recordingFetch();
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () => approvedWith([{ ...ROUTE, signer: "vellum" as const }]),
      fetchImpl,
    });

    const res = await handle(
      post("/webhooks/plugins/meeting-bot/realtime", "{}", PLUGIN_SECRET),
      "meeting-bot",
      "realtime",
    );

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("does not accept the platform secret on a plugin-signed route", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () => approvedWith([ROUTE]),
      fetchImpl,
    });

    const res = await handle(
      post("/webhooks/plugins/meeting-bot/realtime", "{}", VELLUM_SECRET),
      "meeting-bot",
      "realtime",
    );

    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
  });
});

describe("payload limits", () => {
  it("rejects a body over the webhook cap without forwarding it", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () => approvedWith([ROUTE]),
      fetchImpl,
    });

    const res = await handle(
      post("/webhooks/plugins/meeting-bot/realtime", "x".repeat(2048)),
      "meeting-bot",
      "realtime",
    );

    expect(res.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("caps on the streamed bytes, not the Content-Length header", async () => {
    // The caller is unauthenticated, so Content-Length is attacker-controlled
    // and absent on chunked requests — a header-only guard would be bypassable.
    const { calls, fetchImpl } = recordingFetch();
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () => approvedWith([ROUTE]),
      fetchImpl,
    });

    const oversized = new Request(
      "http://gateway/webhooks/plugins/meeting-bot/realtime",
      {
        method: "POST",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("x".repeat(2048)));
            controller.close();
          },
        }),
        // @ts-expect-error -- duplex is required for a streamed request body
        duplex: "half",
      },
    );

    const res = await handle(oversized, "meeting-bot", "realtime");

    expect(res.status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("forwards a body at the cap", async () => {
    const { calls, fetchImpl } = recordingFetch();
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () => approvedWith([ROUTE]),
      fetchImpl,
    });

    const res = await handle(
      post("/webhooks/plugins/meeting-bot/realtime", "x".repeat(1024)),
      "meeting-bot",
      "realtime",
    );

    expect(res.status).toBe(200);
    expect(calls[0]!.body).toHaveLength(1024);
  });
});

describe("upstream failures", () => {
  it("reports a runtime that cannot be reached as 502", async () => {
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () => approvedWith([ROUTE]),
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
    });

    const res = await handle(
      post("/webhooks/plugins/meeting-bot/realtime"),
      "meeting-bot",
      "realtime",
    );

    expect(res.status).toBe(502);
  });

  it("passes an upstream error status through rather than masking it", async () => {
    const handle = createPluginWebhookHandler({
      config: CONFIG,
      credentials: CREDENTIALS,
      resolve: () => approvedWith([ROUTE]),
      fetchImpl: async () => new Response("no such route", { status: 404 }),
    });

    const res = await handle(
      post("/webhooks/plugins/meeting-bot/realtime"),
      "meeting-bot",
      "realtime",
    );

    expect(res.status).toBe(404);
    expect(await res.text()).toBe("no such route");
  });
});
