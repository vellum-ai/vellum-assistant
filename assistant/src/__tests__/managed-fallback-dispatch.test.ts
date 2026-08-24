/**
 * Managed backup-profile dispatch, end to end against a mocked upstream.
 *
 * Everything below the test is production code: the real adapter factory, the
 * real managed-proxy auth resolution, the real `RetryProvider` escalation, and
 * the real Anthropic client. Only the upstream is faked, by a local
 * `Bun.serve` standing in for the platform's runtime proxy, so the assertions
 * are made on the bytes the backup route actually puts on the wire.
 *
 * Deliberately mock-free at the module level: `mock.module` is process-wide in
 * bun, and stubbing the provider clients here would leak into every other file
 * that exercises them.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";

import { createAdapterFromConnection } from "../providers/inference/adapter-factory.js";
import type {
  ProviderConnection,
  ResolvedAuth,
} from "../providers/inference/auth.js";
import type { Message, ProviderResponse } from "../providers/types.js";
import { credentialKey } from "../security/credential-key.js";
import { setSecureKeyAsync } from "../security/secure-keys.js";
import { setConfig } from "./helpers/set-config.js";

// ── Mocked upstream ─────────────────────────────────────────────────────────

interface UpstreamRequest {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const requests: UpstreamRequest[] = [];

/**
 * What the anthropic proxy path does. `retired` is the model rename/retirement
 * shape: fallback-eligible but not retryable, so the escalation decision is
 * reached on the first attempt instead of after a full retry budget.
 */
let anthropicMode: "serve" | "retired" = "serve";

const ANTHROPIC_PATH = "/v1/runtime-proxy/anthropic";
const OPENAI_PATH = "/v1/runtime-proxy/openai";

/** A complete Anthropic Messages SSE stream for a one-word reply. */
function anthropicCompletion(): Response {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_fallback_01",
        type: "message",
        role: "assistant",
        content: [],
        model: "claude-opus-5",
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 1 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "served by the backup" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 4 },
    },
    { type: "message_stop" },
  ];
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(
            `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          ),
        );
      }
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

/** The outage the primary route keeps returning. `retry-after: 0` keeps the
 *  retry loop honest without making the test wait out real backoff. */
function upstreamUnavailable(): Response {
  return new Response(
    JSON.stringify({ error: { message: "upstream unavailable" } }),
    {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "0" },
    },
  );
}

/** A retired model id, the other outage shape fallback exists for. */
function modelRetired(): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: "not_found_error", message: "model: unknown model id" },
    }),
    { status: 404, headers: { "content-type": "application/json" } },
  );
}

let server: ReturnType<typeof Bun.serve>;

// ── Fixtures ────────────────────────────────────────────────────────────────

const MESSAGES: Message[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
];

const ASSISTANT_API_KEY = credentialKey("vellum", "assistant_api_key");
const BYOK_CREDENTIAL = credentialKey("anthropic", "api_key");

const vellumConnection = {
  name: "vellum",
  provider: "vellum",
  auth: { type: "platform" },
  label: "Vellum",
  baseUrl: null,
  models: null,
} as unknown as ProviderConnection;

const byokConnection = {
  name: "anthropic-personal",
  provider: "anthropic",
  auth: { type: "api_key", credential: BYOK_CREDENTIAL },
  label: "Anthropic (personal)",
  baseUrl: null,
  models: null,
} as unknown as ProviderConnection;

function managedAuth(proxyPath: string): ResolvedAuth {
  return {
    kind: "header",
    headers: { Authorization: "Bearer test-assistant-key" },
    baseUrl: `http://127.0.0.1:${server.port}${proxyPath}`,
  };
}

function requestsTo(proxyPath: string): UpstreamRequest[] {
  return requests.filter((r) => r.path.startsWith(proxyPath));
}

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        // Not every probe carries a JSON body; the path alone is enough.
      }
      requests.push({
        path: url.pathname,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      });
      if (url.pathname.startsWith(ANTHROPIC_PATH)) {
        return anthropicMode === "serve"
          ? anthropicCompletion()
          : modelRetired();
      }
      return upstreamUnavailable();
    },
  });
  // Managed-proxy prerequisites: the platform base URL points at the mock
  // upstream, so `buildManagedBaseUrl` derives the per-provider proxy paths
  // above and the backup route resolves its auth for real.
  setConfig("platform", { baseUrl: `http://127.0.0.1:${server.port}` });
  await setSecureKeyAsync(ASSISTANT_API_KEY, "test-assistant-key");
  await setSecureKeyAsync(BYOK_CREDENTIAL, "test-byok-key");
});

afterAll(() => {
  server.stop(true);
});

afterEach(() => {
  requests.length = 0;
  anthropicMode = "serve";
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("managed fallback dispatch", () => {
  test("a managed quality-optimized outage is served on the backup profile", async () => {
    setConfig("llm", { activeProfile: "quality-optimized" });

    // The managed adapter for the primary route: the quality profile's own
    // pin (`gpt-5.6-sol`), whose managed upstream is openai.
    const provider = createAdapterFromConnection(
      vellumConnection,
      managedAuth(OPENAI_PATH),
      {
        model: "gpt-5.6-sol",
        provider: "openai",
        streamTimeoutMs: 30_000,
      },
    );
    expect(provider).not.toBeNull();

    const response: ProviderResponse = await provider!.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    // The primary was tried and kept failing before anything escalated.
    expect(requestsTo(OPENAI_PATH).length).toBeGreaterThan(1);

    // The backup profile's pin served the request, through the same managed
    // connection, on the upstream its own model resolves to.
    const backup = requestsTo(ANTHROPIC_PATH);
    expect(backup.length).toBe(1);
    expect(backup[0].body.model).toBe("claude-opus-5");
    // The backup profile's own settings win over the failed primary's.
    expect(backup[0].body.max_tokens).toBe(32000);
    // `adaptive` is the wire form an adaptive-thinking-only model takes for the
    // backup profile's `thinking.enabled`.
    expect(backup[0].body.thinking).toMatchObject({ type: "adaptive" });

    // Degraded traffic is attributed to the backup profile, both on the wire
    // for the platform's usage events and on the response for the local ledger.
    expect(backup[0].headers["x-vellum-inference-profile"]).toBe(
      "quality-optimized-backup",
    );
    expect(response.actualInferenceProfile).toBe("quality-optimized-backup");
    expect(response.actualProvider).toBe("anthropic");
  });

  test("a BYOK connection never falls back, even on an eligible error", async () => {
    // Pointers like this never exist on a BYOK column, but seeding one proves
    // the gate is the connection identity rather than the absence of a target.
    setConfig("llm", {
      profiles: {
        "byok-primary": {
          source: "user",
          provider: "anthropic",
          model: "claude-opus-5",
          fallbackProfile: "byok-backup",
          maxTokens: 1024,
        },
        "byok-backup": {
          source: "user",
          provider: "anthropic",
          model: "claude-sonnet-5",
          maxTokens: 2048,
        },
      },
      activeProfile: "byok-primary",
    });
    anthropicMode = "retired";

    const provider = createAdapterFromConnection(
      byokConnection,
      {
        kind: "header",
        headers: { Authorization: "Bearer test-byok-key" },
        baseUrl: `http://127.0.0.1:${server.port}${ANTHROPIC_PATH}`,
      },
      { model: "claude-opus-5", streamTimeoutMs: 30_000 },
    );
    expect(provider).not.toBeNull();

    const error = await provider!
      .sendMessage(MESSAGES, { config: { callSite: "mainAgent" } })
      .then(
        () => null,
        (err: unknown) => err,
      );

    // The primary's own error surfaces. A BYOK install may hold no credential
    // for the backup's provider, so an escalation here would leave the vendor's
    // answer to a foreign route in place of the real failure.
    expect((error as { statusCode?: number }).statusCode).toBe(404);
    // Every attempt used the primary's pin: no route was ever escalated.
    const models = new Set(requests.map((r) => r.body.model));
    expect(models).toEqual(new Set(["claude-opus-5"]));
  });

  test("a managed profile with no fallbackProfile rethrows the original error", async () => {
    setConfig("llm", {
      profiles: {
        "managed-no-backup": {
          source: "user",
          provider: "anthropic",
          model: "claude-opus-5",
          maxTokens: 1024,
        },
      },
      activeProfile: "managed-no-backup",
    });
    anthropicMode = "retired";

    const provider = createAdapterFromConnection(
      vellumConnection,
      managedAuth(ANTHROPIC_PATH),
      {
        model: "claude-opus-5",
        provider: "anthropic",
        streamTimeoutMs: 30_000,
      },
    );
    expect(provider).not.toBeNull();

    const error = await provider!
      .sendMessage(MESSAGES, { config: { callSite: "mainAgent" } })
      .then(
        () => null,
        (err: unknown) => err,
      );

    // The original upstream failure surfaces unchanged: the callback found no
    // pointer, so nothing was re-routed and no fallback error replaced it.
    expect(error).toBeInstanceOf(Error);
    expect((error as { statusCode?: number }).statusCode).toBe(404);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    const models = new Set(requests.map((r) => r.body.model));
    expect(models).toEqual(new Set(["claude-opus-5"]));
  });
});
