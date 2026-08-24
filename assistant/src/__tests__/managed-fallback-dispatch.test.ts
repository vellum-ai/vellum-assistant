/**
 * Managed backup-profile dispatch against a mocked platform proxy.
 *
 * The primary test path includes `CallSiteRoutingProvider`, connection
 * selection, the real adapter factory, retry escalation, and provider clients.
 * Only the remote platform proxy is replaced with a local HTTP server.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";

import { CallSiteRoutingProvider } from "../providers/call-site-routing.js";
import {
  resetFallbackBreaker,
  shouldSkipPrimary,
} from "../providers/fallback-breaker.js";
import { createAdapterFromConnection } from "../providers/inference/adapter-factory.js";
import type {
  ProviderConnection,
  ResolvedAuth,
} from "../providers/inference/auth.js";
import type {
  Message,
  Provider,
  ProviderResponse,
} from "../providers/types.js";
import { getManagedUpstream } from "../providers/vellum-model-routing.js";
import { credentialKey } from "../security/credential-key.js";
import { setSecureKeyAsync } from "../security/secure-keys.js";
import { setConfig } from "./helpers/set-config.js";

interface UpstreamRequest {
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

const requests: UpstreamRequest[] = [];
let anthropicMode: "serve" | "retired" | "unavailable" = "serve";

const ANTHROPIC_PATH = "/v1/runtime-proxy/anthropic";
const OPENAI_PATH = "/v1/runtime-proxy/openai";

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

function upstreamUnavailable(): Response {
  return new Response(
    JSON.stringify({ error: { message: "upstream unavailable" } }),
    {
      status: 503,
      headers: { "content-type": "application/json", "retry-after": "0" },
    },
  );
}

function modelRetired(): Response {
  return new Response(
    JSON.stringify({
      type: "error",
      error: { type: "not_found_error", message: "model: unknown model id" },
    }),
    { status: 404, headers: { "content-type": "application/json" } },
  );
}

let server: ReturnType<typeof Bun.serve> | undefined;

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
  if (server === undefined) {
    throw new Error("test proxy is not running");
  }
  return {
    kind: "header",
    headers: { Authorization: "Bearer test-assistant-key" },
    baseUrl: `http://127.0.0.1:${server.port}${proxyPath}`,
  };
}

function requestsTo(proxyPath: string): UpstreamRequest[] {
  return requests.filter((request) => request.path.startsWith(proxyPath));
}

function createManagedAdapter(upstream: string, model: string): Provider {
  const proxyPath =
    upstream === "openai"
      ? OPENAI_PATH
      : upstream === "anthropic"
        ? ANTHROPIC_PATH
        : null;
  if (proxyPath === null) {
    throw new Error(`unsupported test upstream: ${upstream}`);
  }
  const provider = createAdapterFromConnection(
    vellumConnection,
    managedAuth(proxyPath),
    {
      model,
      provider: upstream,
      streamTimeoutMs: 30_000,
    },
  );
  if (provider === null) {
    throw new Error(`failed to create ${upstream} test adapter`);
  }
  return provider;
}

/**
 * Construct the production wrapper order that calls use. The connection
 * resolver builds the managed adapter for the provider/model selected by the
 * call-site router, so fallback eligibility sees the original call-site
 * options while the primary transport matches the resolved route.
 */
function createRoutedManagedProvider(): Provider {
  const defaultProvider = createManagedAdapter("openai", "gpt-5.6-sol");
  return new CallSiteRoutingProvider(
    defaultProvider,
    async (connectionName, expectedProvider, model) => {
      if (connectionName !== "vellum" || model === undefined) {
        return null;
      }
      const upstream =
        expectedProvider === "vellum"
          ? getManagedUpstream(model)
          : expectedProvider;
      return upstream === undefined || upstream === null
        ? null
        : createManagedAdapter(upstream, model);
    },
    defaultProvider.routeAttribution,
  );
}

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

beforeAll(async () => {
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      let body: Record<string, unknown> = {};
      try {
        body = (await req.json()) as Record<string, unknown>;
      } catch {
        // The request path is sufficient for non-JSON probes.
      }
      requests.push({
        path: url.pathname,
        headers: Object.fromEntries(req.headers.entries()),
        body,
      });
      if (url.pathname.startsWith(ANTHROPIC_PATH)) {
        if (anthropicMode === "retired") {
          return modelRetired();
        }
        return anthropicMode === "unavailable"
          ? upstreamUnavailable()
          : anthropicCompletion();
      }
      return upstreamUnavailable();
    },
  });
  setConfig("platform", { baseUrl: `http://127.0.0.1:${server.port}` });
  await setSecureKeyAsync(ASSISTANT_API_KEY, "test-assistant-key");
  await setSecureKeyAsync(BYOK_CREDENTIAL, "test-byok-key");
});

afterAll(() => {
  server?.stop(true);
});

beforeEach(() => {
  resetFallbackBreaker();
});

afterEach(() => {
  requests.length = 0;
  anthropicMode = "serve";
});

describe("managed fallback dispatch", () => {
  test("a managed default outage is served through the routed backup profile", async () => {
    setConfig("llm", { activeProfile: "quality-optimized" });
    const provider = createRoutedManagedProvider();

    const response: ProviderResponse = await provider.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(requestsTo(OPENAI_PATH).length).toBeGreaterThan(1);
    const backup = requestsTo(ANTHROPIC_PATH);
    expect(backup.length).toBe(1);
    expect(backup[0].body.model).toBe("claude-opus-5");
    expect(backup[0].body.max_tokens).toBe(32000);
    expect(backup[0].body.thinking).toMatchObject({ type: "adaptive" });
    expect(backup[0].headers["x-vellum-inference-profile"]).toBe(
      "quality-optimized-backup",
    );
    expect(response.actualInferenceProfile).toBe("quality-optimized-backup");
    expect(response.actualProvider).toBe("anthropic");
  });

  test.each([
    ["model", "gpt-5.6-sol"],
    ["provider", "openai"],
  ] as const)(
    "a persisted call-site %s pin never falls back",
    async (field, value) => {
      setConfig("llm", {
        activeProfile: "quality-optimized",
        callSites: { mainAgent: { [field]: value } },
      });
      const provider = createRoutedManagedProvider();

      const error = await captureError(
        provider.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
      );

      expect((error as { provider?: string }).provider).toBe("openai");
      expect(requestsTo(OPENAI_PATH).length).toBeGreaterThan(1);
      expect(requestsTo(ANTHROPIC_PATH)).toHaveLength(0);
      expect(shouldSkipPrimary({ upstream: "openai" })).toBe(false);
    },
  );

  test("a BYOK connection never installs automatic fallback routing", async () => {
    setConfig("llm", {
      profiles: {
        "byok-primary": {
          source: "user",
          provider: "anthropic",
          model: "claude-opus-5",
          maxTokens: 1024,
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
        baseUrl: `http://127.0.0.1:${server?.port}${ANTHROPIC_PATH}`,
      },
      { model: "claude-opus-5", streamTimeoutMs: 30_000 },
    );
    expect(provider).not.toBeNull();

    const error = await captureError(
      provider!.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect((error as { statusCode?: number }).statusCode).toBe(404);
    expect(new Set(requests.map((request) => request.body.model))).toEqual(
      new Set(["claude-opus-5"]),
    );
  });

  test("a custom managed profile has no automatic fallback contract", async () => {
    setConfig("llm", {
      profiles: {
        custom: {
          source: "user",
          provider: "vellum",
          model: "claude-opus-5",
          maxTokens: 1024,
        },
      },
      activeProfile: "custom",
    });
    anthropicMode = "retired";
    const provider = createRoutedManagedProvider();

    const error = await captureError(
      provider.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect((error as { statusCode?: number }).statusCode).toBe(404);
    expect(new Set(requests.map((request) => request.body.model))).toEqual(
      new Set(["claude-opus-5"]),
    );
  });

  test("a user shadow cannot change the code-owned backup route", async () => {
    setConfig("llm", {
      profiles: {
        "quality-optimized-backup": {
          source: "user",
          provider: "missing-connection-entry",
          model: "custom-model",
        },
      },
      activeProfile: "quality-optimized",
    });
    const provider = createRoutedManagedProvider();

    const response = await provider.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    const backup = requestsTo(ANTHROPIC_PATH);
    expect(backup).toHaveLength(1);
    expect(backup[0].body.model).toBe("claude-opus-5");
    expect(response.actualInferenceProfile).toBe("quality-optimized-backup");
  });

  test("a failed backup preserves the primary error and does not count as served", async () => {
    setConfig("llm", { activeProfile: "quality-optimized" });
    anthropicMode = "unavailable";
    const provider = createRoutedManagedProvider();

    const error = await captureError(
      provider.sendMessage(MESSAGES, { config: { callSite: "mainAgent" } }),
    );

    expect((error as { provider?: string }).provider).toBe("openai");
    expect(requestsTo(OPENAI_PATH).length).toBeGreaterThan(1);
    expect(requestsTo(ANTHROPIC_PATH).length).toBeGreaterThan(0);
    expect(shouldSkipPrimary({ upstream: "openai" })).toBe(false);
  });

  test("a served backup opens the breaker for the routed primary", async () => {
    setConfig("llm", { activeProfile: "quality-optimized" });
    const provider = createRoutedManagedProvider();

    await provider.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });
    expect(shouldSkipPrimary({ upstream: "openai" })).toBe(true);

    requests.length = 0;
    const response = await provider.sendMessage(MESSAGES, {
      config: { callSite: "mainAgent" },
    });

    expect(requestsTo(OPENAI_PATH)).toHaveLength(0);
    expect(requestsTo(ANTHROPIC_PATH)).toHaveLength(1);
    expect(response.actualInferenceProfile).toBe("quality-optimized-backup");
  });
});
