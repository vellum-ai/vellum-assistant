/**
 * The runtime proxy's error path must be transparent.
 *
 * Every OAuth passthrough request (`/v1/oauth/proxy/...`) reaches the provider
 * through this catch-all, so a 4xx/5xx body has to come back byte-for-byte and
 * must never land in the gateway log: those bytes belong to a third-party API
 * and routinely name its customers.
 */

import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { GatewayConfig } from "../config.js";
import { initSigningKey, mintToken } from "../auth/token-service.js";
import { CURRENT_POLICY_EPOCH } from "../auth/policy.js";

type FetchFn = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

let fetchMock: ReturnType<typeof mock<FetchFn>> = mock(
  async () => new Response(),
);

mock.module("../fetch.js", () => ({
  fetchImpl: (...args: Parameters<FetchFn>) => fetchMock(...args),
}));

type LogCall = {
  level: string;
  fields: Record<string, unknown>;
  msg: string;
};

let logCalls: LogCall[] = [];

function recorder(level: string) {
  return (fields: unknown, msg?: string) => {
    logCalls.push({
      level,
      fields: (fields ?? {}) as Record<string, unknown>,
      msg: msg ?? "",
    });
  };
}

const actualLogger = await import("../logger.js");

mock.module("../logger.js", () => ({
  ...actualLogger,
  getLogger: () => ({
    debug: recorder("debug"),
    info: recorder("info"),
    warn: recorder("warn"),
    error: recorder("error"),
  }),
}));

const { createRuntimeProxyHandler } =
  await import("../http/routes/runtime-proxy.js");

const TEST_SIGNING_KEY = Buffer.from("test-signing-key-at-least-32-bytes-long");
initSigningKey(TEST_SIGNING_KEY);

const TOKEN = mintToken({
  aud: "vellum-gateway",
  sub: "actor:test-assistant:test-user",
  scope_profile: "actor_client_v1",
  policy_epoch: CURRENT_POLICY_EPOCH,
  ttlSeconds: 300,
});

function makeConfig(): GatewayConfig {
  return {
    assistantRuntimeBaseUrl: "http://localhost:7821",
    routingEntries: [],
    port: 7830,
    runtimeProxyRequireAuth: true,
    shutdownDrainMs: 5000,
    runtimeTimeoutMs: 30000,
    runtimeMaxRetries: 2,
    runtimeInitialBackoffMs: 500,
    maxWebhookPayloadBytes: 1048576,
    logFile: { dir: undefined, retentionDays: 30 },
    maxAttachmentBytes: {
      telegram: 50 * 1024 * 1024,
      slack: 100 * 1024 * 1024,
      whatsapp: 16 * 1024 * 1024,
      default: 50 * 1024 * 1024,
    },
    maxAttachmentConcurrency: 3,
    gatewayInternalBaseUrl: "http://127.0.0.1:7830",
    trustProxy: false,
  };
}

/** Reply to the next proxied request with these exact bytes. */
function mockUpstream(
  body: BodyInit | null,
  status: number,
  headers: Record<string, string> = {},
) {
  fetchMock = mock(async () => new Response(body, { status, headers }));
}

function proxyRequest(path: string, method = "GET"): Request {
  return new Request(`http://localhost:7830${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

/** The single "Upstream returned error" record, or undefined. */
function upstreamErrorLog(): LogCall | undefined {
  return logCalls.find((c) => c.msg === "Upstream returned error");
}

const PROXY_PATH = "/v1/oauth/proxy/stripe/v1/charges";

beforeEach(() => {
  logCalls = [];
  fetchMock = mock(async () => new Response());
});

describe("runtime proxy error bodies", () => {
  test("returns a non-UTF-8 provider error body byte-for-byte", async () => {
    // Raw 0xff/0xfe, a bare continuation byte, and an encoded surrogate:
    // decoding this as UTF-8 turns all six into U+FFFD.
    const bytes = new Uint8Array([
      0x7b, 0xff, 0xfe, 0x80, 0x41, 0xed, 0xa0, 0x80, 0x7d,
    ]);
    mockUpstream(bytes, 402, { "content-type": "application/json" });

    const res = await createRuntimeProxyHandler(makeConfig())(
      proxyRequest(PROXY_PATH),
    );

    expect(res.status).toBe(402);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  test("declares the content-length of the bytes it re-emits", async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x41]);
    // A stale upstream length: text round-tripping these bytes would grow them.
    mockUpstream(bytes, 409, { "content-length": "99" });

    const res = await createRuntimeProxyHandler(makeConfig())(
      proxyRequest(PROXY_PATH),
    );

    expect(res.headers.get("content-length")).toBe("4");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  test("returns a long multi-byte error body whole", async () => {
    const text = `{"error":"${"日本語テキスト🎉".repeat(40)}"}`;
    mockUpstream(text, 429, { "content-type": "application/json" });

    const res = await createRuntimeProxyHandler(makeConfig())(
      proxyRequest(PROXY_PATH),
    );

    expect(await res.text()).toBe(text);
  });

  test("keeps a proxied provider error body out of the log", async () => {
    const secret = "cus_9f3 alice@example.com sk_live_notatoken";
    mockUpstream(`{"error":{"message":"${secret}"}}`, 400);

    await createRuntimeProxyHandler(makeConfig())(proxyRequest(PROXY_PATH));

    const record = upstreamErrorLog();
    expect(record).toBeDefined();
    expect(record!.level).toBe("warn");
    expect(record!.fields).not.toHaveProperty("body");
    expect(JSON.stringify(logCalls)).not.toContain("cus_9f3");
    expect(JSON.stringify(logCalls)).not.toContain("alice@example.com");
  });

  test("logs only the byte count for a non-proxy route error", async () => {
    // Pins the decision: no route keeps the body snippet. A path allowlist
    // would leak again the next time a passthrough family is added.
    mockUpstream("assistant said no", 404);

    await createRuntimeProxyHandler(makeConfig())(
      proxyRequest("/v1/conversations/abc"),
    );

    const record = upstreamErrorLog();
    expect(record).toBeDefined();
    expect(record!.fields).not.toHaveProperty("body");
    expect(record!.fields.bodyBytes).toBe(17);
    expect(record!.fields.status).toBe(404);
    expect(JSON.stringify(logCalls)).not.toContain("assistant said no");
  });

  test("logs a 5xx at error level, still without the body", async () => {
    mockUpstream("upstream stack trace", 502);

    await createRuntimeProxyHandler(makeConfig())(
      proxyRequest("/v1/conversations/abc"),
    );

    const record = upstreamErrorLog();
    expect(record!.level).toBe("error");
    expect(record!.fields).not.toHaveProperty("body");
    expect(JSON.stringify(logCalls)).not.toContain("upstream stack trace");
  });

  test("keeps the entity metadata of a failed HEAD", async () => {
    // A HEAD answers with the headers describing a body it omits, so the
    // buffer here is empty by definition and says nothing about the entity.
    // The daemon preserves both headers for a HEAD; this hop has to as well,
    // or a HEAD that fails reports a zero-length, unencoded entity.
    mockUpstream(null, 404, {
      "content-length": "5120",
      "content-encoding": "gzip",
      "content-type": "application/json",
    });

    const res = await createRuntimeProxyHandler(makeConfig())(
      proxyRequest(PROXY_PATH, "HEAD"),
    );

    expect(res.status).toBe(404);
    expect(res.headers.get("content-length")).toBe("5120");
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect((await res.arrayBuffer()).byteLength).toBe(0);
  });

  test("still reframes the buffer on a failed GET", async () => {
    mockUpstream("nope", 404, {
      "content-length": "5120",
      "content-encoding": "gzip",
    });

    const res = await createRuntimeProxyHandler(makeConfig())(
      proxyRequest(PROXY_PATH),
    );

    expect(res.headers.get("content-length")).toBe("4");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.text()).toBe("nope");
  });

  test("leaves a successful response streaming and untouched", async () => {
    mockUpstream('{"ok":true}', 200, { "content-type": "application/json" });

    const res = await createRuntimeProxyHandler(makeConfig())(
      proxyRequest(PROXY_PATH),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(upstreamErrorLog()).toBeUndefined();
  });
});
