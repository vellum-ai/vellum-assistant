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

  test("the backup adapter serves the model a call-site tweak resolves to", async () => {
    // A call site's own tuning fragment layers OVER the winning profile, so a
    // `model` tweak decides the model even when the backup profile is forced.
    // The adapter has to be built for THAT model's upstream: deriving it from
    // the backup profile's own pin would send an OpenAI-shaped request through
    // an Anthropic adapter (or the reverse).
    setConfig("llm", {
      profiles: {
        "tweaked-primary": {
          source: "user",
          provider: "vellum",
          model: "gpt-5.6-sol",
          fallbackProfile: "tweaked-backup",
          maxTokens: 1024,
        },
        // Deliberately an OpenAI pin, so the backup profile's own model and the
        // call-site tweak below resolve to different upstreams.
        "tweaked-backup": {
          source: "user",
          provider: "vellum",
          model: "gpt-5.6-terra",
          maxTokens: 2048,
        },
      },
      activeProfile: "tweaked-primary",
      callSites: { mainAgent: { model: "claude-opus-5" } },
    });

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

    // The escalation followed the tweak, not the backup profile's own pin: the
    // request reached the Anthropic upstream carrying the Anthropic model.
    const backup = requestsTo(ANTHROPIC_PATH);
    expect(backup.length).toBe(1);
    expect(backup[0].body.model).toBe("claude-opus-5");
    // Deriving the upstream from the backup profile's own OpenAI pin instead
    // would have escalated straight back to the failing OpenAI path, so the
    // request never reaches Anthropic at all.
    expect(requestsTo(OPENAI_PATH).length).toBeGreaterThan(0);
    expect(response.actualProvider).toBe("anthropic");
    expect(response.actualInferenceProfile).toBe("tweaked-backup");
  });

  test("a backup routing outside the managed connection is refused", async () => {
    // The schema allows a pointer at a user-defined profile that carries its
    // own BYOK provider. Serving it here would authenticate someone's personal
    // route with the managed credential and bill it as managed traffic, so the
    // escalation is declined and the primary's failure stands.
    setConfig("llm", {
      profiles: {
        "managed-primary": {
          source: "user",
          provider: "vellum",
          model: "claude-opus-5",
          fallbackProfile: "byok-target",
          maxTokens: 1024,
        },
        "byok-target": {
          source: "user",
          provider: "anthropic",
          model: "claude-sonnet-5",
          maxTokens: 2048,
        },
      },
      activeProfile: "managed-primary",
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

    expect(error).toBeInstanceOf(Error);
    expect((error as { statusCode?: number }).statusCode).toBe(404);
    // Nothing was re-routed: the backup's model never went on the wire.
    const models = new Set(requests.map((r) => r.body.model));
    expect(models).toEqual(new Set(["claude-opus-5"]));
  });

  test("a managed backup still serves under a call-site provider tweak", async () => {
    // A call-site fragment pinning a concrete upstream over a managed winner
    // resolves to that provider while the resolver keeps the managed
    // connection, so this is managed traffic and must still fall back. The
    // guard above keys on the connection precisely so this case survives.
    setConfig("llm", {
      profiles: {
        "tweak-primary": {
          source: "user",
          provider: "vellum",
          model: "gpt-5.6-sol",
          fallbackProfile: "tweak-managed-backup",
          maxTokens: 1024,
        },
        "tweak-managed-backup": {
          source: "user",
          provider: "vellum",
          model: "claude-opus-5",
          maxTokens: 2048,
        },
      },
      activeProfile: "tweak-primary",
      callSites: { mainAgent: { provider: "anthropic" } },
    });

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

    const backup = requestsTo(ANTHROPIC_PATH);
    expect(backup.length).toBe(1);
    expect(backup[0].body.model).toBe("claude-opus-5");
    expect(response.actualInferenceProfile).toBe("tweak-managed-backup");
  });

  test("the backup upstream follows the resolved provider, not the model's catalog owner", async () => {
    // The divergent shape: a call-site fragment pins a concrete upstream while
    // the backup profile's own model belongs to a different one. Normal
    // dispatch routes this by the resolved provider (`connection-resolution`
    // threads it through as `providerOverride` for the managed connection), so
    // the fallback has to as well. Deriving the upstream from the model instead
    // sends the request somewhere the primary route never would have.
    setConfig("llm", {
      profiles: {
        "divergent-primary": {
          source: "user",
          provider: "vellum",
          model: "gpt-5.6-sol",
          fallbackProfile: "divergent-backup",
          maxTokens: 1024,
        },
        // An OpenAI-owned model under an Anthropic call-site pin: the resolved
        // provider and the model's catalog owner disagree.
        "divergent-backup": {
          source: "user",
          provider: "vellum",
          model: "gpt-5.6-terra",
          maxTokens: 2048,
        },
      },
      activeProfile: "divergent-primary",
      callSites: { mainAgent: { provider: "anthropic" } },
    });

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

    // The escalation went to the pinned provider's upstream carrying the
    // resolved model. Routing by the model's catalog owner would have escalated
    // straight back onto the failing OpenAI path, so nothing reaches Anthropic.
    const backup = requestsTo(ANTHROPIC_PATH);
    expect(backup.length).toBe(1);
    expect(backup[0].body.model).toBe("gpt-5.6-terra");
    expect(response.actualProvider).toBe("anthropic");
    expect(response.actualInferenceProfile).toBe("divergent-backup");
  });

  test("a backup whose resolved provider cannot front the managed proxy is refused", async () => {
    // The connection guard passes (the resolver keeps the managed connection),
    // but the pinned provider is not one the platform proxy serves. There is no
    // upstream to build an adapter for, so the primary's failure stands rather
    // than the request being quietly rerouted to the model's catalog owner.
    setConfig("llm", {
      profiles: {
        "unroutable-primary": {
          source: "user",
          provider: "vellum",
          model: "claude-opus-5",
          fallbackProfile: "unroutable-backup",
          maxTokens: 1024,
        },
        // Named on the managed connection, so the connection guard lets it
        // through, but `openrouter` is not a managed-routable upstream.
        "unroutable-backup": {
          source: "user",
          provider: "openrouter",
          provider_connection: "vellum",
          model: "claude-sonnet-5",
          maxTokens: 2048,
        },
      },
      activeProfile: "unroutable-primary",
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

    expect(error).toBeInstanceOf(Error);
    expect((error as { statusCode?: number }).statusCode).toBe(404);
    const models = new Set(requests.map((r) => r.body.model));
    expect(models).toEqual(new Set(["claude-opus-5"]));
  });
});
