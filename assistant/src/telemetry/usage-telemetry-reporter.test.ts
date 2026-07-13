/**
 * Tests for UsageTelemetryReporter.
 *
 * Covers the authenticated send path (and the skip behavior when credentials
 * are absent or the platform is disabled), watermark advancement, error
 * handling, batch recursion, device ID resolution, and payload shape.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks (must precede production imports)
// ---------------------------------------------------------------------------

// Watermark storage fake, injected via the reporter's constructor (see
// `makeReporter` below) — the real store lives on the telemetry DB and has
// its own DB-backed test, so it is deliberately NOT module-mocked here.
const mockGetFlushCheckpoint = mock<(key: string) => string | null>(() => null);
const mockSetFlushCheckpoint = mock<(key: string, value: string) => void>(
  () => {},
);
const mockIsFlushCheckpointStoreAvailable = mock<() => boolean>(() => true);

const fakeFlushCheckpointStore = {
  isAvailable: () => mockIsFlushCheckpointStoreAvailable(),
  get: (key: string) => mockGetFlushCheckpoint(key),
  set: (key: string, value: string) => mockSetFlushCheckpoint(key, value),
};

const mockQueryUnreportedUsageEvents = mock(
  () =>
    [] as ReturnType<
      typeof import("../persistence/llm-usage-store.js").queryUnreportedUsageEvents
    >,
);

mock.module("../persistence/llm-usage-store.js", () => ({
  queryUnreportedUsageEvents: mockQueryUnreportedUsageEvents,
}));

const mockQueryUnreportedTurnEvents = mock(
  () =>
    [] as {
      id: string;
      createdAt: number;
      conversationId: string;
      conversationType: string;
      turnIndex: number;
      interfaceId: string | null;
      channelId: string | null;
      clientMetadata: string | null;
      outcome?: string | null;
      batchedInto?: string | null;
      failureCode?: string | null;
    }[],
);

mock.module("./turn-events-store.js", () => ({
  queryUnreportedTurnEvents: mockQueryUnreportedTurnEvents,
}));

let mockPlatformClient: Record<string, unknown> | null = null;

mock.module("../platform/client.js", () => ({
  VellumPlatformClient: {
    create: async () => mockPlatformClient,
  },
}));

const mockGetPlatformBaseUrl = mock(() => "https://platform.vellum.ai");

const mockGetPlatformOrganizationId = mock(() => "");
const mockGetPlatformUserId = mock(() => "");

mock.module("../config/env.js", () => ({
  getPlatformBaseUrl: mockGetPlatformBaseUrl,
  getPlatformOrganizationId: mockGetPlatformOrganizationId,
  getPlatformUserId: mockGetPlatformUserId,
  // Re-export anything else the module might import transitively
  str: () => undefined,
  num: () => undefined,
  bool: () => false,
}));

const mockGetDeviceId = mock(() => "test-device-id");

mock.module("../util/device-id.js", () => ({
  getDeviceId: mockGetDeviceId,
}));

mock.module("../version.js", () => ({
  APP_VERSION: "1.2.3-test",
}));

const mockGetCachedShareAnalytics = mock(() => true);
// Owner's `share_diagnostics` consent — one part of the trace-collection gate.
const mockGetCachedShareDiagnostics = mock(() => false);
// Owner's accepted diagnostics-consent version — the disclosing-version part of
// the trace gate. Default to a far-future (unconditionally eligible) version so
// the consent cases drive eligibility on that axis; the version-specific
// cases override it with old/empty values.
const mockGetCachedShareDiagnosticsVersion = mock(() => "2999-01-01");

mock.module("../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: mockGetCachedShareAnalytics,
  getCachedShareDiagnostics: mockGetCachedShareDiagnostics,
  getCachedShareDiagnosticsVersion: mockGetCachedShareDiagnosticsVersion,
}));

interface MockTurnTrace {
  schema_version: 3;
  messages: {
    id: string;
    role: string;
    created_at: number;
    content: unknown;
    model: string | null;
  }[];
  tool_calls: unknown[];
  system_prompt: string | null;
  tool_definitions: {
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }[];
}

// Returns a non-null bounded trace by default; individual tests override the
// return value (including null, for the over-cap / assembly-failure path).
function defaultBoundedTurnTrace(boundary: {
  conversationId: string;
  userMessageId: string;
  userMessageCreatedAt: number;
}): MockTurnTrace | null {
  return {
    schema_version: 3,
    messages: [
      {
        id: boundary.userMessageId,
        role: "user",
        created_at: boundary.userMessageCreatedAt,
        content: [{ type: "text", text: "hello" }],
        model: null,
      },
    ],
    tool_calls: [],
    system_prompt: "You are a helpful assistant.",
    tool_definitions: [
      {
        name: "web_search",
        description: "Search the web",
        input_schema: {},
      },
    ],
  };
}

const mockAssembleBoundedTurnTrace = mock(defaultBoundedTurnTrace);

// Turn-completeness gate. Default: every turn is settled (complete), so the
// deferral barrier never fires unless a test opts a turn into "in-flight".
const mockIsTurnSettled = mock(
  (_boundary: {
    conversationId: string;
    userMessageId: string;
    userMessageCreatedAt: number;
  }): boolean => true,
);

mock.module("./turn-trace-store.js", () => ({
  assembleBoundedTurnTrace: mockAssembleBoundedTurnTrace,
  isTurnSettled: mockIsTurnSettled,
}));

const mockQueryUnreportedLifecycleEvents = mock(
  () =>
    [] as {
      id: string;
      eventName: string;
      createdAt: number;
    }[],
);

mock.module("../persistence/lifecycle-events-store.js", () => ({
  queryUnreportedLifecycleEvents: mockQueryUnreportedLifecycleEvents,
}));

const mockQueryUnreportedOnboardingEvents = mock(
  () =>
    [] as {
      id: string;
      createdAt: number;
      screen: string;
      toolsJson: string | null;
      tasksJson: string | null;
      tone: string | null;
      googleConnected: boolean | null;
      googleScopesJson: string | null;
      priorAssistantsJson: string | null;
      abVariant: string | null;
      sessionId: string | null;
      stepName: string | null;
      stepIndex: number | null;
      completedAt: string | null;
      funnelVersion: string | null;
    }[],
);

mock.module("../onboarding/onboarding-events-store.js", () => ({
  queryUnreportedOnboardingEvents: mockQueryUnreportedOnboardingEvents,
}));

// The auth-fallback, tool-executed, and skill-loaded stores are intentionally
// NOT mocked — they have their own DB-backed tests, and Bun's `mock.module`
// is process-global, so mocking them here would leak into those tests when
// files share an invocation. We seed the real DB instead so every test stays
// order-independent.

// ---------------------------------------------------------------------------
// Production import (after mocks)
// ---------------------------------------------------------------------------

import {
  seedToolInvocation as seedToolInvocationRow,
  TOOL_INVOCATION_PII_SENTINEL as TOOL_PII_SENTINEL,
  type ToolInvocationSeedSpec,
} from "../__tests__/test-support/tool-invocation-seed.js";
import { getDb, getTelemetryDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  authFallbackEvents,
  configSettingEvents,
  conversations,
  skillLoadedEvents,
  toolInvocations,
} from "../persistence/schema/index.js";
import { recordAuthFallbackCounts } from "../security/auth-fallback-events-store.js";
import type { UsageEvent } from "../usage/types.js";
import {
  ACTIVATION_FUNNEL_VERSION,
  buildActivationDaemonEventId,
} from "./activation-funnel.js";
import { recordConfigSettingEvent } from "./config-setting-events-store.js";
import { recordSkillLoadedEvent } from "./skill-loaded-events-store.js";
import {
  ALL_TELEMETRY_EVENT_SOURCES,
  DAEMON_TELEMETRY_EVENT_SOURCES,
  MONITOR_TELEMETRY_EVENT_SOURCES,
} from "./telemetry-event-sources.js";
import {
  initToolExecutedWatermarkIfAbsent,
  UsageTelemetryReporter,
} from "./usage-telemetry-reporter.js";

/**
 * Construct a reporter wired to the in-memory checkpoint fake. All tests go
 * through this so watermark reads/writes stay assertable via the mocks
 * without process-global module mocking of the real telemetry-DB store.
 */
function makeReporter(): UsageTelemetryReporter {
  return new UsageTelemetryReporter(
    ALL_TELEMETRY_EVENT_SOURCES,
    fakeFlushCheckpointStore,
  );
}

await initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let eventIdCounter = 0;

// The reporter consumes `UnreportedUsageEvent` (UsageEvent + the
// JOIN-computed fields `conversationType` and `turnIndex`). Build that
// shape directly so the mock matches `queryUnreportedUsageEvents`'
// return type exactly.
type UnreportedUsageEventFixture = UsageEvent & {
  conversationType: string | null;
  turnIndex: number | null;
};

function makeUsageEvent(
  overrides: Partial<UnreportedUsageEventFixture> = {},
): UnreportedUsageEventFixture {
  eventIdCounter += 1;
  return {
    id: `evt-${eventIdCounter}`,
    createdAt: 1700000000000 + eventIdCounter * 1000,
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    inputTokens: 100,
    outputTokens: 50,
    cacheCreationInputTokens: 10,
    cacheReadInputTokens: 5,
    rawUsage: null,
    actor: "main_agent",
    callSite: null,
    inferenceProfile: null,
    inferenceProfileSource: null,
    conversationId: "conv-1",
    runId: null,
    requestId: null,
    estimatedCostUsd: 0.001,
    pricingStatus: "priced",
    assistantVersion: "test-app-version",
    conversationType: "standard",
    turnIndex: 1,
    llmCallCount: 1,
    ...overrides,
  };
}

type OnboardingEventFixture = ReturnType<
  typeof mockQueryUnreportedOnboardingEvents
>[number];

function makeOnboardingEvent(
  overrides: Partial<OnboardingEventFixture> = {},
): OnboardingEventFixture {
  eventIdCounter += 1;
  return {
    id: `onb-${eventIdCounter}`,
    createdAt: 1700000000000 + eventIdCounter * 1000,
    screen: "tools",
    toolsJson: null,
    tasksJson: null,
    tone: null,
    googleConnected: null,
    googleScopesJson: null,
    priorAssistantsJson: null,
    abVariant: null,
    sessionId: null,
    stepName: null,
    stepIndex: null,
    completedAt: null,
    funnelVersion: null,
    ...overrides,
  };
}

const TOOL_CONVERSATION_ID = "conv-reporter-tool-executed";

function seedToolInvocation(
  spec: Omit<ToolInvocationSeedSpec, "conversationId">,
): void {
  seedToolInvocationRow(
    { db: getDb(), conversations, toolInvocations },
    { ...spec, conversationId: TOOL_CONVERSATION_ID },
  );
}

/**
 * Replace the default null-returning checkpoint mocks with a Map-backed
 * implementation so values persisted by the reporter (e.g. the
 * construction-time tool_executed watermark init) are visible to later
 * reads within the same test.
 */
function useStatefulCheckpoints(
  seed: Record<string, string> = {},
): Map<string, string> {
  const checkpoints = new Map(Object.entries(seed));
  mockGetFlushCheckpoint.mockImplementation(
    (key) => checkpoints.get(key) ?? null,
  );
  mockSetFlushCheckpoint.mockImplementation((key, value) => {
    checkpoints.set(key, value);
  });
  return checkpoints;
}

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  eventIdCounter = 0;
  // Default consent ON so the happy-path send tests exercise the flush.
  mockGetCachedShareAnalytics.mockReset();
  mockGetCachedShareAnalytics.mockReturnValue(true);
  // Default `share_diagnostics` consent OFF — most tests don't expect a trace;
  // the trace-specific tests opt in explicitly.
  mockGetCachedShareDiagnostics.mockReset();
  mockGetCachedShareDiagnostics.mockReturnValue(false);
  // Default the accepted consent version eligible so trace tests drive the gate
  // via the share_diagnostics knob; version cases override it.
  mockGetCachedShareDiagnosticsVersion.mockReset();
  mockGetCachedShareDiagnosticsVersion.mockReturnValue("2999-01-01");
  mockAssembleBoundedTurnTrace.mockReset();
  mockAssembleBoundedTurnTrace.mockImplementation(defaultBoundedTurnTrace);
  mockIsTurnSettled.mockReset();
  mockIsTurnSettled.mockReturnValue(true);
  mockGetFlushCheckpoint.mockReset();
  mockSetFlushCheckpoint.mockReset();
  mockIsFlushCheckpointStoreAvailable.mockReset();
  mockIsFlushCheckpointStoreAvailable.mockReturnValue(true);
  mockQueryUnreportedUsageEvents.mockReset();
  mockQueryUnreportedTurnEvents.mockReset();
  mockQueryUnreportedTurnEvents.mockReturnValue([]);
  mockQueryUnreportedLifecycleEvents.mockReset();
  mockQueryUnreportedLifecycleEvents.mockReturnValue([]);
  mockQueryUnreportedOnboardingEvents.mockReset();
  mockQueryUnreportedOnboardingEvents.mockReturnValue([]);
  getDb().delete(toolInvocations).run();
  getTelemetryDb()!.delete(skillLoadedEvents).run();
  getTelemetryDb()!.delete(authFallbackEvents).run();
  getTelemetryDb()!.delete(configSettingEvents).run();
  delete process.env.VELLUM_DISABLE_PLATFORM;
  delete process.env.IS_PLATFORM;
  mockGetPlatformBaseUrl.mockReset();
  mockGetDeviceId.mockReset();
  mockGetDeviceId.mockReturnValue("test-device-id");
  mockGetPlatformOrganizationId.mockReset();
  mockGetPlatformOrganizationId.mockReturnValue("");
  mockGetPlatformUserId.mockReset();
  mockGetPlatformUserId.mockReturnValue("");

  // Defaults
  mockGetFlushCheckpoint.mockReturnValue(null);
  mockGetPlatformBaseUrl.mockReturnValue("https://platform.vellum.ai");

  mockFetch = mock(() =>
    Promise.resolve(new Response('{"accepted":0}', { status: 200 })),
  );
  globalThis.fetch = mockFetch as unknown as typeof fetch;

  // Default to an authenticated client whose fetch delegates to the mockFetch
  // spy, so the existing payload/body assertions keep working. The reporter
  // sends authenticated-only; tests that exercise the no-credentials path
  // override this with `mockPlatformClient = null`.
  mockPlatformClient = {
    baseUrl: "https://test.vellum.ai",
    assistantApiKey: "test-key",
    platformAssistantId: "asst-123",
    fetch: (path: string, init?: RequestInit) => mockFetch(path, init),
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.VELLUM_DISABLE_PLATFORM;
  delete process.env.IS_PLATFORM;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("UsageTelemetryReporter", () => {
  test("authenticated flush uses client.fetch with platform path", async () => {
    const clientFetchMock = mock(async (_path: string, _init?: RequestInit) => {
      return new Response('{"accepted":2}', { status: 200 });
    });
    mockPlatformClient = {
      baseUrl: "https://test.vellum.ai",
      assistantApiKey: "test-key",
      platformAssistantId: "asst-123",
      fetch: clientFetchMock,
    };
    const events = [makeUsageEvent(), makeUsageEvent()];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);

    const reporter = makeReporter();
    await reporter.flush();

    expect(clientFetchMock).toHaveBeenCalledTimes(1);
    const [path] = clientFetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/v1/telemetry/ingest/");
    // globalThis.fetch should NOT have been called directly
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("flush is skipped when no platform credentials are available", async () => {
    // Authenticated-only: with no client, nothing is sent and the watermark is
    // left intact so the backlog ships once credentials resolve.
    mockPlatformClient = null;

    const events = [makeUsageEvent()];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).not.toHaveBeenCalled();
    const watermarkCalls = mockSetFlushCheckpoint.mock.calls.filter(
      (c) => c[0] === "telemetry:usage:last_reported_at",
    );
    expect(watermarkCalls.length).toBe(0);
  });

  test("flush is skipped when VELLUM_DISABLE_PLATFORM is set in local mode", async () => {
    // The platform-disabled toggle suppresses the send. Unlike the opt-out
    // branch, watermarks are NOT advanced, so the backlog ships once the flag
    // is cleared.
    process.env.VELLUM_DISABLE_PLATFORM = "true";

    const events = [makeUsageEvent()];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);

    const reporter = makeReporter();
    // Construction initializes the absent tool_executed watermark; clear that
    // call so the assertion below covers only the flush.
    mockSetFlushCheckpoint.mockClear();
    await reporter.flush();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockSetFlushCheckpoint).not.toHaveBeenCalled();
  });

  test("VELLUM_DISABLE_PLATFORM is ignored when IS_PLATFORM is set (managed mode)", async () => {
    // Platform-managed assistants always connect to the platform; an inherited
    // VELLUM_DISABLE_PLATFORM must not suppress telemetry for them (matches
    // arePlatformFeaturesEnabled / VellumPlatformClient.create()).
    process.env.IS_PLATFORM = "true";
    process.env.VELLUM_DISABLE_PLATFORM = "true";

    const events = [makeUsageEvent()];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("watermark advances on successful upload", async () => {
    const events = [
      makeUsageEvent({ id: "evt-w1", createdAt: 1700000001000 }),
      makeUsageEvent({ id: "evt-w2", createdAt: 1700000002000 }),
    ];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":2}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    const watermarkCalls = mockSetFlushCheckpoint.mock.calls.filter(
      (c) => c[0] === "telemetry:usage:last_reported_at",
    );
    expect(watermarkCalls.length).toBeGreaterThanOrEqual(1);
    // The watermark should be set to the createdAt of the last event
    expect(watermarkCalls[watermarkCalls.length - 1][1]).toBe(
      String(1700000002000),
    );

    // The compound cursor ID should also be set to the last event's id
    const idCalls = mockSetFlushCheckpoint.mock.calls.filter(
      (c) => c[0] === "telemetry:usage:last_reported_id",
    );
    expect(idCalls.length).toBeGreaterThanOrEqual(1);
    expect(idCalls[idCalls.length - 1][1]).toBe("evt-w2");
  });

  test("watermark stays on failed upload", async () => {
    const events = [makeUsageEvent()];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response("error", { status: 500 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    const watermarkCalls = mockSetFlushCheckpoint.mock.calls.filter(
      (c) => c[0] === "telemetry:usage:last_reported_at",
    );
    expect(watermarkCalls.length).toBe(0);
  });

  test("installation ID comes from per-device getDeviceId", async () => {
    const events = [makeUsageEvent()];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();

    // First flush — should use the per-device ID
    await reporter.flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body1 = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body1.device_id).toBe("test-device-id");

    // Second flush — should use the same value
    mockQueryUnreportedUsageEvents.mockReturnValue([makeUsageEvent()]);
    await reporter.flush();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const body2 = JSON.parse(
      (mockFetch.mock.calls[1] as [string, RequestInit])[1].body as string,
    );
    expect(body2.device_id).toBe("test-device-id");
  });

  test("empty batch makes no HTTP call", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("batch recursion when full, capped at 10", async () => {
    // Always return exactly 500 events (BATCH_SIZE) to trigger recursion
    const fullBatch = Array.from({ length: 500 }, (_, i) =>
      makeUsageEvent({ id: `evt-batch-${i}`, createdAt: 1700000000000 + i }),
    );
    mockQueryUnreportedUsageEvents.mockReturnValue(fullBatch);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":500}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    // MAX_CONSECUTIVE_BATCHES = 10
    expect(mockFetch).toHaveBeenCalledTimes(10);
  });

  test("stop() performs final flush", async () => {
    const events = [makeUsageEvent()];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    reporter.start();

    // Wait a tick so start()'s immediate flush settles.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const callsBeforeStop = mockFetch.mock.calls.length;

    await reporter.stop();

    // stop() must trigger at least one additional flush beyond what start() did.
    expect(mockFetch.mock.calls.length).toBeGreaterThan(callsBeforeStop);
  });

  test("payload shape is correct", async () => {
    const event = makeUsageEvent({
      id: "evt-shape-test",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      inputTokens: 200,
      outputTokens: 100,
      cacheCreationInputTokens: 20,
      cacheReadInputTokens: 15,
      actor: "context_compactor",
      callSite: "compactionAgent",
      inferenceProfile: "quality-optimized",
      inferenceProfileSource: "conversation",
      llmCallCount: 3,
      createdAt: 1700000099000,
    });
    mockQueryUnreportedUsageEvents.mockReturnValue([event]);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );

    // Top-level: device_id, assistant_version, and events array (no turn_events key)
    expect(body.device_id).toBe("test-device-id");
    expect(body.assistant_version).toBe("1.2.3-test");
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBe(1);
    expect(body.turn_events).toBeUndefined();

    const e = body.events[0];
    expect(e.type).toBe("llm_usage");
    expect(e.daemon_event_id).toBe("evt-shape-test");
    expect(e.provider).toBe("anthropic");
    expect(e.model).toBe("claude-sonnet-4-20250514");
    expect(e.input_tokens).toBe(200);
    expect(e.output_tokens).toBe(100);
    expect(e.cache_creation_input_tokens).toBe(20);
    expect(e.cache_read_input_tokens).toBe(15);
    expect(e.llm_call_count).toBe(3);
    expect(e.actor).toBe("context_compactor");
    expect(e.llm_call_site).toBe("compactionAgent");
    expect(e.inference_profile).toBe("quality-optimized");
    expect(e.inference_profile_source).toBe("conversation");
    expect(e.cost).toBe(0.001);
    expect(e.recorded_at).toBe(1700000099000);
    // raw_usage defaults to null on this fixture (the makeUsageEvent default),
    // confirming the wire shape carries the key as `null` rather than
    // dropping it for legacy rows or providers that did not return a
    // usage block.
    expect(e.raw_usage).toBeNull();
  });

  test("payload forwards the provider's raw_usage block verbatim", async () => {
    // The reporter must surface the literal usage object the provider
    // returned (Anthropic nests TTL breakdown under `cache_creation`,
    // OpenAI nests cached-read counts under `prompt_tokens_details`,
    // etc.) so downstream consumers can extract any provider-specific
    // detail without a wire-level schema change. Anything that
    // transforms, summarises, or strips fields here destroys data the
    // admin charts and dbt models depend on.
    const rawUsage = {
      input_tokens: 200,
      output_tokens: 100,
      cache_creation_input_tokens: 750,
      cache_creation: {
        ephemeral_5m_input_tokens: 250,
        ephemeral_1h_input_tokens: 500,
      },
      cache_read_input_tokens: 15,
      service_tier: "standard",
    };
    const event = makeUsageEvent({
      id: "evt-raw-usage",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      cacheCreationInputTokens: 750,
      rawUsage,
    });
    mockQueryUnreportedUsageEvents.mockReturnValue([event]);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    const e = body.events[0];
    expect(e.cache_creation_input_tokens).toBe(750);
    expect(e.raw_usage).toEqual(rawUsage);
  });

  test("payload preserves null attribution for historical usage rows", async () => {
    const event = makeUsageEvent({
      id: "evt-legacy-usage",
      callSite: null,
      inferenceProfile: null,
      inferenceProfileSource: null,
      llmCallCount: null,
    });
    mockQueryUnreportedUsageEvents.mockReturnValue([event]);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.events[0]).toMatchObject({
      type: "llm_usage",
      daemon_event_id: "evt-legacy-usage",
      llm_call_site: null,
      inference_profile: null,
      inference_profile_source: null,
      llm_call_count: null,
    });
  });

  test("cost is null when estimatedCostUsd is null (unpriced event)", async () => {
    const event = makeUsageEvent({
      id: "evt-unpriced",
      estimatedCostUsd: null,
      pricingStatus: "unpriced",
    });
    mockQueryUnreportedUsageEvents.mockReturnValue([event]);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.events[0].cost).toBeNull();
  });

  test("organization_id and user_id included in payload when available", async () => {
    mockGetPlatformOrganizationId.mockReturnValue("org-123");
    mockGetPlatformUserId.mockReturnValue("user-456");
    const events = [makeUsageEvent()];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.organization_id).toBe("org-123");
    expect(body.user_id).toBe("user-456");
  });

  test("organization_id and user_id omitted from payload when empty", async () => {
    mockGetPlatformOrganizationId.mockReturnValue("");
    mockGetPlatformUserId.mockReturnValue("");
    const events = [makeUsageEvent()];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.organization_id).toBeUndefined();
    expect(body.user_id).toBeUndefined();
  });

  test("payload does not include assistant_id", async () => {
    const events = [makeUsageEvent()];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.assistant_id).toBeUndefined();
  });

  test("turn events are included in the events array with type discriminator", async () => {
    const usageEvent = makeUsageEvent({ id: "evt-mixed-usage" });
    mockQueryUnreportedUsageEvents.mockReturnValue([usageEvent]);
    mockQueryUnreportedTurnEvents.mockReturnValue([
      {
        id: "evt-mixed-turn",
        createdAt: 1700000050000,
        conversationId: "conv-mixed",
        conversationType: "standard",
        turnIndex: 1,
        interfaceId: null,
        channelId: null,
        clientMetadata: null,
      },
    ]);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":2}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );

    // Single events array containing both types
    expect(body.events.length).toBe(2);
    expect(body.turn_events).toBeUndefined();

    const llmEvent = body.events.find(
      (e: { type: string }) => e.type === "llm_usage",
    );
    const turnEvent = body.events.find(
      (e: { type: string }) => e.type === "turn",
    );

    expect(llmEvent).toBeDefined();
    expect(llmEvent.daemon_event_id).toBe("evt-mixed-usage");

    expect(turnEvent).toBeDefined();
    expect(turnEvent.daemon_event_id).toBe("evt-mixed-turn");
    expect(turnEvent.recorded_at).toBe(1700000050000);
    expect(turnEvent.conversation_id).toBe("conv-mixed");
    expect(turnEvent.conversation_type).toBe("standard");
    expect(turnEvent.turn_index).toBe(1);
  });

  test("turn events carry conversation_type for background/scheduled conversations", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    mockQueryUnreportedTurnEvents.mockReturnValue([
      {
        id: "evt-turn-standard",
        createdAt: 1700000100000,
        conversationId: "conv-std",
        conversationType: "standard",
        turnIndex: 1,
        interfaceId: null,
        channelId: null,
        clientMetadata: null,
      },
      {
        id: "evt-turn-background",
        createdAt: 1700000200000,
        conversationId: "conv-bg",
        conversationType: "background",
        turnIndex: 1,
        interfaceId: null,
        channelId: null,
        clientMetadata: null,
      },
      {
        id: "evt-turn-scheduled",
        createdAt: 1700000300000,
        conversationId: "conv-sched",
        conversationType: "scheduled",
        turnIndex: 1,
        interfaceId: null,
        channelId: null,
        clientMetadata: null,
      },
    ]);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":3}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );

    const byId: Record<string, { conversation_type: string }> = {};
    for (const e of body.events as Array<{
      daemon_event_id: string;
      conversation_type: string;
    }>) {
      byId[e.daemon_event_id] = e;
    }

    expect(byId["evt-turn-standard"].conversation_type).toBe("standard");
    expect(byId["evt-turn-background"].conversation_type).toBe("background");
    expect(byId["evt-turn-scheduled"].conversation_type).toBe("scheduled");
  });

  test("turn events carry interface_id, channel_id, and parsed client metadata", async () => {
    // Four turns spanning the relevant cases:
    //  - macOS in-app turn with full client block (typical interactive user)
    //  - slack inbound turn with no client block (channel-based, no headers)
    //  - web turn with malformed client JSON (parsing guard: emit null,
    //    do not break the batch)
    //  - historical turn with no metadata at all (pre-rollout row)
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    mockQueryUnreportedTurnEvents.mockReturnValue([
      {
        id: "evt-turn-macos",
        createdAt: 1700000400000,
        conversationId: "conv-mac",
        conversationType: "standard",
        turnIndex: 1,
        interfaceId: "macos",
        channelId: "vellum",
        clientMetadata: JSON.stringify({
          browser_family: null,
          os: "darwin",
          interface_version: "0.8.2",
        }),
      },
      {
        id: "evt-turn-slack",
        createdAt: 1700000500000,
        conversationId: "conv-slack",
        conversationType: "standard",
        turnIndex: 1,
        interfaceId: "slack",
        channelId: "slack",
        clientMetadata: null,
      },
      {
        id: "evt-turn-web-broken",
        createdAt: 1700000600000,
        conversationId: "conv-web",
        conversationType: "standard",
        turnIndex: 1,
        interfaceId: "web",
        channelId: "vellum",
        clientMetadata: "{not valid json",
      },
      {
        id: "evt-turn-legacy",
        createdAt: 1700000700000,
        conversationId: "conv-legacy",
        conversationType: "standard",
        turnIndex: 1,
        interfaceId: null,
        channelId: null,
        clientMetadata: null,
      },
    ]);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":4}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );

    const byId: Record<
      string,
      {
        interface_id: string | null;
        channel_id: string | null;
        client: Record<string, unknown> | null;
      }
    > = {};
    for (const e of body.events as Array<{
      daemon_event_id: string;
      interface_id: string | null;
      channel_id: string | null;
      client: Record<string, unknown> | null;
    }>) {
      byId[e.daemon_event_id] = e;
    }

    expect(byId["evt-turn-macos"]).toMatchObject({
      interface_id: "macos",
      channel_id: "vellum",
      client: {
        os: "darwin",
        interface_version: "0.8.2",
      },
    });
    expect(byId["evt-turn-slack"]).toMatchObject({
      interface_id: "slack",
      channel_id: "slack",
      client: null,
    });
    // Malformed client JSON is downgraded to null without failing the
    // batch — the interface_id/channel_id from the typed columns still
    // ride through cleanly.
    expect(byId["evt-turn-web-broken"]).toMatchObject({
      interface_id: "web",
      channel_id: "vellum",
      client: null,
    });
    expect(byId["evt-turn-legacy"]).toMatchObject({
      interface_id: null,
      channel_id: null,
      client: null,
    });
  });

  // -------------------------------------------------------------------------
  // Per-turn trace collection (gated on share_diagnostics consent at an
  // eligible accepted version)
  // -------------------------------------------------------------------------

  function singleTurnEvent() {
    return [
      {
        id: "evt-turn-trace",
        createdAt: 1700000050000,
        conversationId: "conv-trace",
        conversationType: "standard",
        turnIndex: 2,
        interfaceId: "macos",
        channelId: "vellum",
        clientMetadata: null,
      },
    ];
  }

  test("attaches the assembled trace when share_diagnostics and an eligible consent version are both true", async () => {
    mockGetCachedShareDiagnostics.mockReturnValue(true);
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    mockQueryUnreportedTurnEvents.mockReturnValue(singleTurnEvent());
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    // The assembler is called with the turn's (conversationId, id, createdAt)
    // boundary so the window lines up with the turn event.
    expect(mockAssembleBoundedTurnTrace).toHaveBeenCalledTimes(1);
    expect(mockAssembleBoundedTurnTrace.mock.calls[0][0]).toEqual({
      conversationId: "conv-trace",
      userMessageId: "evt-turn-trace",
      userMessageCreatedAt: 1700000050000,
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    // Still exactly one event — the single turn event, now carrying `trace`.
    expect(body.events.length).toBe(1);
    const turn = body.events[0];
    expect(turn.type).toBe("turn");
    expect(turn.daemon_event_id).toBe("evt-turn-trace");
    expect(turn.trace).toBeDefined();
    expect(turn.trace.schema_version).toBe(3);
    expect(turn.trace.messages[0].id).toBe("evt-turn-trace");
    expect(turn.trace.messages[0].model).toBeNull();
    expect(Array.isArray(turn.trace.tool_calls)).toBe(true);
  });

  test("omits the trace when share_diagnostics is false (and still emits the turn event)", async () => {
    mockGetCachedShareDiagnostics.mockReturnValue(false);
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    mockQueryUnreportedTurnEvents.mockReturnValue(singleTurnEvent());
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    // Gate off → no assembly at all (no PII touched).
    expect(mockAssembleBoundedTurnTrace).not.toHaveBeenCalled();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    // The single turn event still flushes — just without a trace.
    expect(body.events.length).toBe(1);
    const turn = body.events[0];
    expect(turn.type).toBe("turn");
    expect(turn.daemon_event_id).toBe("evt-turn-trace");
    expect("trace" in turn).toBe(false);
  });

  test("omits the trace when the accepted consent version predates the disclosure threshold (share_diagnostics on)", async () => {
    mockGetCachedShareDiagnostics.mockReturnValue(true);
    // Consent recorded under an older version that never disclosed trace
    // collection → gate closed, mirroring the platform ingest gate.
    mockGetCachedShareDiagnosticsVersion.mockReturnValue("2000-01-01");
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    mockQueryUnreportedTurnEvents.mockReturnValue(singleTurnEvent());
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    // Version below threshold → no assembly at all (no PII touched).
    expect(mockAssembleBoundedTurnTrace).not.toHaveBeenCalled();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.events.length).toBe(1);
    expect("trace" in body.events[0]).toBe(false);
  });

  test("omits the trace when the owner never accepted a versioned consent (empty version)", async () => {
    mockGetCachedShareDiagnostics.mockReturnValue(true);
    // Empty version (never accepted / no-row default where share_diagnostics is
    // true but unversioned) fails closed.
    mockGetCachedShareDiagnosticsVersion.mockReturnValue("");
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    mockQueryUnreportedTurnEvents.mockReturnValue(singleTurnEvent());
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockAssembleBoundedTurnTrace).not.toHaveBeenCalled();
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.events.length).toBe(1);
    expect("trace" in body.events[0]).toBe(false);
  });

  test("omits the trace (key absent) when the assembler returns null (over-cap / failure) but still emits the turn event", async () => {
    mockGetCachedShareDiagnostics.mockReturnValue(true);
    // Over-cap / assembly-failure path: the bounded assembler returns null.
    mockAssembleBoundedTurnTrace.mockReturnValueOnce(null);
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    mockQueryUnreportedTurnEvents.mockReturnValue(singleTurnEvent());
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockAssembleBoundedTurnTrace).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.events.length).toBe(1);
    expect("trace" in body.events[0]).toBe(false);
  });

  test("no trace is assembled or attached when the whole flush is gated off by share_analytics", async () => {
    // The analytics gate short-circuits the entire flush; trace assembly must
    // never run (and nothing is sent) even when the trace gate is fully on
    // (share_diagnostics true at an eligible version).
    mockGetCachedShareAnalytics.mockReturnValue(false);
    mockGetCachedShareDiagnostics.mockReturnValue(true);
    mockQueryUnreportedTurnEvents.mockReturnValue(singleTurnEvent());

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockAssembleBoundedTurnTrace).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Trace completeness barrier — don't emit partial traces mid-turn
  // -------------------------------------------------------------------------

  function turnEvent(
    id: string,
    createdAt: number,
    conversationId: string,
    overrides: {
      outcome?: string | null;
      batchedInto?: string | null;
      failureCode?: string | null;
    } = {},
  ) {
    return {
      id,
      createdAt,
      conversationId,
      conversationType: "standard",
      turnIndex: 1,
      interfaceId: "macos",
      channelId: "vellum",
      clientMetadata: null,
      ...overrides,
    };
  }

  test("a flush during an in-progress turn defers it (no partial trace, watermark held)", async () => {
    mockGetCachedShareDiagnostics.mockReturnValue(true);
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    const checkpoints = useStatefulCheckpoints();
    mockQueryUnreportedTurnEvents.mockReturnValue([
      turnEvent("evt-inflight", 1700000050000, "conv-1"),
    ]);
    // The turn's response is still streaming — not settled.
    mockIsTurnSettled.mockReturnValue(false);

    const reporter = makeReporter();
    await reporter.flush();

    // No trace assembled, and the turn is NOT sent (the only event was deferred).
    expect(mockAssembleBoundedTurnTrace).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    // The turn watermark must NOT advance past the deferred turn.
    expect(checkpoints.get("telemetry:turns:last_reported_at")).toBeUndefined();
    expect(checkpoints.get("telemetry:turns:last_reported_id")).toBeUndefined();
  });

  test("a later flush emits the COMPLETE trace once the turn settles", async () => {
    mockGetCachedShareDiagnostics.mockReturnValue(true);
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    const checkpoints = useStatefulCheckpoints();
    mockQueryUnreportedTurnEvents.mockReturnValue([
      turnEvent("evt-inflight", 1700000050000, "conv-1"),
    ]);

    // Flush 1: turn in progress -> deferred, nothing sent.
    mockIsTurnSettled.mockReturnValue(false);
    const reporter = makeReporter();
    await reporter.flush();
    expect(mockFetch).not.toHaveBeenCalled();

    // Flush 2: the response + tool results have landed; the turn is settled and
    // the full trace assembles. The same (still-unreported) turn now ships.
    mockIsTurnSettled.mockReturnValue(true);
    mockAssembleBoundedTurnTrace.mockReturnValue({
      schema_version: 3,
      messages: [
        {
          id: "evt-inflight",
          role: "user",
          created_at: 1700000050000,
          content: [{ type: "text", text: "do a thing" }],
          model: null,
        },
        {
          id: "asst-1",
          role: "assistant",
          created_at: 1700000051000,
          content: [{ type: "text", text: "done" }],
          model: "claude-fable-5",
        },
      ],
      tool_calls: [{ id: "ti-1" }],
      system_prompt: "You are a helpful assistant.",
      tool_definitions: [],
    });
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.events.length).toBe(1);
    const turn = body.events[0];
    expect(turn.daemon_event_id).toBe("evt-inflight");
    // The COMPLETE transcript: user message + assistant response + tool call.
    expect(turn.trace.messages.map((m: { id: string }) => m.id)).toEqual([
      "evt-inflight",
      "asst-1",
    ]);
    expect(turn.trace.tool_calls).toHaveLength(1);
    // Watermark now advances to the (now-complete) turn.
    expect(checkpoints.get("telemetry:turns:last_reported_at")).toBe(
      String(1700000050000),
    );
    expect(checkpoints.get("telemetry:turns:last_reported_id")).toBe(
      "evt-inflight",
    );
  });

  test("the final turn of a conversation still gets its complete trace once its own response finishes", async () => {
    // No successor turn exists; `isTurnSettled` returns true purely because the
    // conversation is no longer processing. The trace must still be sent (not
    // deferred forever for lack of a next user turn).
    mockGetCachedShareDiagnostics.mockReturnValue(true);
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    mockQueryUnreportedTurnEvents.mockReturnValue([
      turnEvent("evt-final", 1700000060000, "conv-final"),
    ]);
    mockIsTurnSettled.mockReturnValue(true);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockAssembleBoundedTurnTrace).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.events.length).toBe(1);
    expect(body.events[0].daemon_event_id).toBe("evt-final");
    expect(body.events[0].trace).toBeDefined();
  });

  test("barrier: a complete turn ordered AFTER an in-flight turn is also deferred (no watermark skip)", async () => {
    // The turn watermark is a single monotonic cursor, so a complete turn that
    // sorts after a deferred in-flight turn cannot be reported without skipping
    // the deferred one. Both wait; the earlier complete turn (before the
    // barrier) is reported.
    mockGetCachedShareDiagnostics.mockReturnValue(true);
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    const checkpoints = useStatefulCheckpoints();
    mockQueryUnreportedTurnEvents.mockReturnValue([
      turnEvent("evt-a-complete", 1700000010000, "conv-a"),
      turnEvent("evt-b-inflight", 1700000020000, "conv-b"),
      turnEvent("evt-c-complete", 1700000030000, "conv-c"),
    ]);
    // Only the middle turn is in-flight.
    mockIsTurnSettled.mockImplementation(
      (b) => b.userMessageId !== "evt-b-inflight",
    );
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    // Only the turn BEFORE the in-flight barrier is reported.
    expect(
      body.events.map((e: { daemon_event_id: string }) => e.daemon_event_id),
    ).toEqual(["evt-a-complete"]);
    // Watermark stops at the last reported turn, NOT the later complete turn —
    // so the deferred middle turn is never skipped.
    expect(checkpoints.get("telemetry:turns:last_reported_at")).toBe(
      String(1700000010000),
    );
    expect(checkpoints.get("telemetry:turns:last_reported_id")).toBe(
      "evt-a-complete",
    );
  });

  test("with tracing disabled, an in-progress turn is still deferred (outcome stamps must ship with the event)", async () => {
    // The completeness barrier applies to every turn event, not just
    // trace-eligible ones: the `outcome` stamp is written while the
    // conversation is still processing, and the watermark advances on ship,
    // so an in-flight turn reported early would be frozen without its stamp.
    mockGetCachedShareDiagnostics.mockReturnValue(false);
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    const checkpoints = useStatefulCheckpoints();
    mockQueryUnreportedTurnEvents.mockReturnValue([
      turnEvent("evt-inflight", 1700000050000, "conv-1"),
    ]);
    mockIsTurnSettled.mockReturnValue(false);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockIsTurnSettled).toHaveBeenCalled();
    // Nothing ships and the watermark holds, so the turn is retried complete.
    expect(mockFetch).not.toHaveBeenCalled();
    expect(checkpoints.get("telemetry:turns:last_reported_at")).toBeUndefined();
  });

  test("with tracing disabled, a settled turn ships trace-free and advances the watermark", async () => {
    mockGetCachedShareDiagnostics.mockReturnValue(false);
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    const checkpoints = useStatefulCheckpoints();
    mockQueryUnreportedTurnEvents.mockReturnValue([
      turnEvent("evt-settled", 1700000050000, "conv-1"),
    ]);
    mockIsTurnSettled.mockReturnValue(true);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.events.length).toBe(1);
    expect(body.events[0].daemon_event_id).toBe("evt-settled");
    expect("trace" in body.events[0]).toBe(false);
    // Watermark advances as usual.
    expect(checkpoints.get("telemetry:turns:last_reported_at")).toBe(
      String(1700000050000),
    );
  });

  test("outcome stamps ride the turn event: batched carries batched_into, failed carries failure_code", async () => {
    mockGetCachedShareDiagnostics.mockReturnValue(false);
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    useStatefulCheckpoints();
    mockQueryUnreportedTurnEvents.mockReturnValue([
      turnEvent("evt-batched-head", 1700000010000, "conv-1", {
        outcome: "batched",
        batchedInto: "evt-batch-final",
      }),
      turnEvent("evt-batch-final", 1700000011000, "conv-1"),
      turnEvent("evt-failed", 1700000012000, "conv-2", {
        outcome: "failed",
        failureCode: "PROVIDER_RATE_LIMIT",
      }),
      turnEvent("evt-cancelled", 1700000013000, "conv-3", {
        outcome: "cancelled",
      }),
    ]);
    mockIsTurnSettled.mockReturnValue(true);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":4}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    const byId = Object.fromEntries(
      body.events.map((e: { daemon_event_id: string }) => [
        e.daemon_event_id,
        e,
      ]),
    );
    expect(byId["evt-batched-head"].outcome).toBe("batched");
    expect(byId["evt-batched-head"].batched_into).toBe("evt-batch-final");
    expect("failure_code" in byId["evt-batched-head"]).toBe(false);
    // The batch-final turn replied normally: no outcome keys at all.
    expect("outcome" in byId["evt-batch-final"]).toBe(false);
    expect("batched_into" in byId["evt-batch-final"]).toBe(false);
    expect(byId["evt-failed"].outcome).toBe("failed");
    expect(byId["evt-failed"].failure_code).toBe("PROVIDER_RATE_LIMIT");
    expect("batched_into" in byId["evt-failed"]).toBe(false);
    expect(byId["evt-cancelled"].outcome).toBe("cancelled");
    expect("failure_code" in byId["evt-cancelled"]).toBe(false);
  });

  test("an unrecognized outcome value in metadata is dropped from the wire", async () => {
    mockGetCachedShareDiagnostics.mockReturnValue(false);
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    useStatefulCheckpoints();
    mockQueryUnreportedTurnEvents.mockReturnValue([
      turnEvent("evt-garbage", 1700000010000, "conv-1", {
        outcome: "exploded",
        batchedInto: "evt-other",
        failureCode: "BOOM",
      }),
    ]);
    mockIsTurnSettled.mockReturnValue(true);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect("outcome" in body.events[0]).toBe(false);
    expect("batched_into" in body.events[0]).toBe(false);
    expect("failure_code" in body.events[0]).toBe(false);
  });

  test("llm_usage events carry conversation_id, conversation_type, and turn_index", async () => {
    // Three LLM calls across the spectrum of the new fields:
    //  - tied to a conversation, mid-turn (typical foreground)
    //  - tied to a background conversation, first turn
    //  - untied (memory consolidation: no conversation, no turn)
    mockQueryUnreportedUsageEvents.mockReturnValue([
      makeUsageEvent({
        id: "evt-fg-call",
        conversationId: "conv-fg",
        conversationType: "standard",
        turnIndex: 4,
      }),
      makeUsageEvent({
        id: "evt-bg-call",
        conversationId: "conv-bg",
        conversationType: "background",
        turnIndex: 1,
      }),
      makeUsageEvent({
        id: "evt-untied-call",
        conversationId: null,
        conversationType: null,
        turnIndex: null,
      }),
    ]);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":3}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );

    const byId: Record<
      string,
      {
        type: string;
        conversation_id: string | null;
        conversation_type: string | null;
        turn_index: number | null;
      }
    > = {};
    for (const e of body.events as Array<{
      type: string;
      daemon_event_id: string;
      conversation_id: string | null;
      conversation_type: string | null;
      turn_index: number | null;
    }>) {
      byId[e.daemon_event_id] = e;
    }

    expect(byId["evt-fg-call"]).toMatchObject({
      type: "llm_usage",
      conversation_id: "conv-fg",
      conversation_type: "standard",
      turn_index: 4,
    });
    expect(byId["evt-bg-call"]).toMatchObject({
      type: "llm_usage",
      conversation_id: "conv-bg",
      conversation_type: "background",
      turn_index: 1,
    });
    // LLM calls without a parent conversation flush through with all
    // three conversation-level fields null — the serializer accepts
    // allow_null and downstream SQL filters can `WHERE conversation_id
    // IS NOT NULL` to scope to foreground analytics.
    expect(byId["evt-untied-call"]).toMatchObject({
      type: "llm_usage",
      conversation_id: null,
      conversation_type: null,
      turn_index: null,
    });
  });

  test("flush is skipped and watermarks advanced when share_analytics consent is off", async () => {
    mockGetCachedShareAnalytics.mockReturnValue(false);
    const events = [makeUsageEvent()];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    // Construction initializes the absent tool_executed watermark; clear that
    // call so the count below covers only the flush's advancement.
    mockSetFlushCheckpoint.mockClear();
    await reporter.flush();

    // No HTTP call should have been made
    expect(mockFetch).not.toHaveBeenCalled();

    // All 9 timestamp watermarks should have been advanced, and all 9 ID
    // watermarks pinned to the high-sorting sentinel (a truthy value keeps
    // the compound-cursor branch active while closing its same-millisecond
    // arm against opt-out rows).
    expect(mockSetFlushCheckpoint).toHaveBeenCalledTimes(18);

    const calls = mockSetFlushCheckpoint.mock.calls;
    const keys = calls.map((c) => c[0]);
    const eventTypes = [
      "usage",
      "turns",
      "lifecycle",
      "onboarding",
      "auth_fallback",
      "tool_executed",
      "skill_loaded",
      "watchdog",
      "config_setting",
    ];
    for (const eventType of eventTypes) {
      expect(keys).toContain(`telemetry:${eventType}:last_reported_at`);
      const idCall = calls.find(
        (c) => c[0] === `telemetry:${eventType}:last_reported_id`,
      );
      expect(idCall?.[1]).toBe("ffffffff-ffff-ffff-ffff-ffffffffffff");
    }
  });

  test("platform disabled takes precedence over consent off — watermarks NOT advanced", async () => {
    // VELLUM_DISABLE_PLATFORM keeps the consent cache false (the consent
    // refresh can't create a platform client), so both gates would fire. The
    // platform-disabled gate runs first and returns without advancing
    // watermarks, preserving the backlog until the flag is cleared — a
    // deployment toggle must not be treated as a privacy opt-out.
    process.env.VELLUM_DISABLE_PLATFORM = "true";
    mockGetCachedShareAnalytics.mockReturnValue(false);
    const events = [makeUsageEvent()];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);

    const reporter = makeReporter();
    // Construction initializes the absent tool_executed watermark; clear that
    // call so the assertion below covers only the flush.
    mockSetFlushCheckpoint.mockClear();
    await reporter.flush();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockSetFlushCheckpoint).not.toHaveBeenCalled();
  });

  test("flush skipped entirely when the flush-checkpoint store is unavailable", async () => {
    // An unreadable checkpoint store must not be mistaken for cursor 0 —
    // that would requery and re-ship history from the beginning. Nothing is
    // sent and no watermark is touched (not even the opt-out sentinel);
    // the cycle retries once the store is back.
    mockIsFlushCheckpointStoreAvailable.mockReturnValue(false);
    const events = [makeUsageEvent()];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);

    const reporter = makeReporter();
    // Construction initializes the absent tool_executed watermark; clear
    // those calls so the assertions below cover only the flush.
    mockGetFlushCheckpoint.mockClear();
    mockSetFlushCheckpoint.mockClear();
    await reporter.flush();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockGetFlushCheckpoint).not.toHaveBeenCalled();
    expect(mockSetFlushCheckpoint).not.toHaveBeenCalled();
  });

  test("events sent normally after re-granting share_analytics consent", async () => {
    // First flush with opt-out — watermarks advance, nothing sent
    mockGetCachedShareAnalytics.mockReturnValue(false);
    const reporter = makeReporter();
    await reporter.flush();
    expect(mockFetch).not.toHaveBeenCalled();
    mockSetFlushCheckpoint.mockReset();

    // Re-grant consent and flush with new events
    mockGetCachedShareAnalytics.mockReturnValue(true);
    const events = [makeUsageEvent({ id: "evt-after-reenable" })];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.events[0].daemon_event_id).toBe("evt-after-reenable");
  });

  // -------------------------------------------------------------------------
  // Per-event `assistant_version` on the wire
  //
  // The envelope's `assistant_version` is upload-time (always the current
  // binary). The per-event field is record-time (the binary that was running
  // when the event was persisted to SQLite). In this PR only `llm_usage`
  // events carry a true record-time value; turn events (and lifecycle /
  // onboarding events, not asserted here) stamp the running binary's
  // `APP_VERSION` directly until their respective follow-ups land.
  // Nullable llm_usage cases (legacy rows from before migration 267 ran)
  // fall back to the running binary's `APP_VERSION` rather than emitting
  // explicit `null` — under the platform contract a present-but-null
  // per-event value would override the envelope, and we'd rather have a
  // concrete version than no version.
  // -------------------------------------------------------------------------

  test("llm_usage event carries its recorded assistantVersion on the wire", async () => {
    const event = makeUsageEvent({
      id: "evt-version-llm",
      assistantVersion: "0.8.4",
    });
    mockQueryUnreportedUsageEvents.mockReturnValue([event]);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    // Envelope reflects current binary (upload-time).
    expect(body.assistant_version).toBe("1.2.3-test");
    // Per-event reflects record-time — a different value here is the
    // whole point: backlogged events keep the binary they were stamped
    // with when they were originally recorded.
    expect(body.events[0].assistant_version).toBe("0.8.4");
  });

  test("llm_usage event with null assistantVersion falls back to APP_VERSION (pre-migration row)", async () => {
    const event = makeUsageEvent({
      id: "evt-version-llm-null",
      assistantVersion: null,
    });
    mockQueryUnreportedUsageEvents.mockReturnValue([event]);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    // No explicit null on the wire — the running binary's APP_VERSION is
    // stamped instead so a present-but-null value can't override the
    // envelope under the platform's per-event-wins contract.
    expect(body.events[0].assistant_version).toBe("1.2.3-test");
  });

  test("turn event emits assistant_version: APP_VERSION (running binary)", async () => {
    // Turn events are derived from `messages` + `conversations`, which
    // don't yet carry a per-event version. Until the follow-up migration
    // adds a column to `messages`, we stamp the running binary's
    // APP_VERSION instead of explicit null — matches what the envelope
    // would have provided but per-event so it survives the platform
    // contract that treats present per-event values as winning over the
    // envelope.
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    mockQueryUnreportedTurnEvents.mockReturnValue([
      {
        id: "evt-turn-version",
        createdAt: 1700000300000,
        conversationId: "conv-1",
        conversationType: "standard",
        turnIndex: 1,
        interfaceId: null,
        channelId: null,
        clientMetadata: null,
      },
    ]);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    const turn = body.events.find((e: { type: string }) => e.type === "turn");
    expect(turn).toBeDefined();
    expect(turn.assistant_version).toBe("1.2.3-test");
  });

  test("a single batch can carry mixed per-event versions", async () => {
    // The whole point of this migration: an old backlogged event keeps
    // its old version while a freshly recorded event in the same flush
    // carries the current version. Pre-migration the entire batch would
    // collapse to the envelope value.
    const oldEvent = makeUsageEvent({
      id: "evt-old",
      assistantVersion: "0.8.3",
    });
    const newEvent = makeUsageEvent({
      id: "evt-new",
      assistantVersion: "0.8.5",
    });
    mockQueryUnreportedUsageEvents.mockReturnValue([oldEvent, newEvent]);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":2}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    const versions = body.events.map(
      (e: { assistant_version: string | null }) => e.assistant_version,
    );
    expect(versions.sort()).toEqual(["0.8.3", "0.8.5"]);
    // Envelope still reflects the running binary, not either event.
    expect(body.assistant_version).toBe("1.2.3-test");
  });

  // -------------------------------------------------------------------------
  // Auth-fallback events
  // -------------------------------------------------------------------------

  test("auth_fallback events are included in the events array with type discriminator", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    recordAuthFallbackCounts(1700000740000, 1700000800000, [
      {
        guard: "edge",
        path: "/v1/messages",
        failureKind: "missing_authorization",
        count: 42,
      },
    ]);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.events.length).toBe(1);
    expect(body.events[0]).toMatchObject({
      type: "auth_fallback",
      guard: "edge",
      path: "/v1/messages",
      failure_kind: "missing_authorization",
      count: 42,
      window_start: 1700000740000,
      window_end: 1700000800000,
      assistant_version: "1.2.3-test",
    });
    // recorded_at is the row's createdAt (stamped at record time).
    expect(typeof body.events[0].recorded_at).toBe("number");
    expect(typeof body.events[0].daemon_event_id).toBe("string");
  });

  test("auth_fallback watermark advances to the last reported row on success", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    recordAuthFallbackCounts(1700000000000, 1700000001000, [
      {
        guard: "edge-scoped",
        path: "/v1/a",
        failureKind: "insufficient_scope",
        count: 1,
      },
      {
        guard: "edge-guardian",
        path: "/v1/b",
        failureKind: "guardian_mismatch",
        count: 3,
      },
    ]);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":2}', { status: 200 })),
    );

    // The last row by the reporter's (createdAt, id) cursor order is the one
    // whose watermark should be persisted after a successful upload.
    const rows = getTelemetryDb()!
      .select()
      .from(authFallbackEvents)
      .orderBy(authFallbackEvents.createdAt, authFallbackEvents.id)
      .all();
    const lastRow = rows[rows.length - 1];

    const reporter = makeReporter();
    await reporter.flush();

    const watermarkCalls = mockSetFlushCheckpoint.mock.calls.filter(
      (c) => c[0] === "telemetry:auth_fallback:last_reported_at",
    );
    expect(watermarkCalls.length).toBeGreaterThanOrEqual(1);
    expect(watermarkCalls[watermarkCalls.length - 1][1]).toBe(
      String(lastRow.createdAt),
    );

    const idCalls = mockSetFlushCheckpoint.mock.calls.filter(
      (c) => c[0] === "telemetry:auth_fallback:last_reported_id",
    );
    expect(idCalls.length).toBeGreaterThanOrEqual(1);
    expect(idCalls[idCalls.length - 1][1]).toBe(lastRow.id);
  });

  // -------------------------------------------------------------------------
  // Onboarding / activation funnel events
  // -------------------------------------------------------------------------

  test("activation onboarding row serializes funnel fields + deterministic daemon_event_id", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    const sessionId = "sess-activation-1";
    const stepName = "activation_moment_1_complete";
    mockQueryUnreportedOnboardingEvents.mockReturnValue([
      makeOnboardingEvent({
        id: "onb-activation-1",
        screen: stepName,
        abVariant: "variant-a",
        sessionId,
        stepName,
        stepIndex: 1,
        completedAt: "2026-06-06T00:00:00.000Z",
        funnelVersion: ACTIVATION_FUNNEL_VERSION,
      }),
    ]);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.events.length).toBe(1);
    expect(body.events[0]).toMatchObject({
      type: "onboarding",
      session_id: sessionId,
      step_name: stepName,
      step_index: 1,
      completed_at: "2026-06-06T00:00:00.000Z",
      funnel_version: "activation_v1_2026_06",
      daemon_event_id: buildActivationDaemonEventId(sessionId, stepName),
    });
  });

  test("activation daemon_event_id is keyed on the row's stored funnel_version, not the binary constant", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    const sessionId = "sess-activation-old";
    const stepName = "activation_moment_1_complete";
    // A row recorded under an OLDER funnel version, queued across an upgrade.
    const oldVersion = "activation_v0_2026_05";
    expect(oldVersion).not.toBe(ACTIVATION_FUNNEL_VERSION);
    mockQueryUnreportedOnboardingEvents.mockReturnValue([
      makeOnboardingEvent({
        id: "onb-activation-old",
        screen: stepName,
        abVariant: "variant-a",
        sessionId,
        stepName,
        stepIndex: 1,
        completedAt: "2026-05-01T00:00:00.000Z",
        funnelVersion: oldVersion,
      }),
    ]);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.events[0]).toMatchObject({
      funnel_version: oldVersion,
      daemon_event_id: buildActivationDaemonEventId(
        sessionId,
        stepName,
        oldVersion,
      ),
    });
    // Guard: the id must carry the row's version, not the binary constant.
    expect(body.events[0].daemon_event_id).toBe(
      `${oldVersion}:${sessionId}:${stepName}`,
    );
  });

  test("legacy onboarding row keeps daemon_event_id: e.id and omits funnel fields", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    mockQueryUnreportedOnboardingEvents.mockReturnValue([
      makeOnboardingEvent({
        id: "onb-legacy-1",
        screen: "tools",
        toolsJson: JSON.stringify(["calendar"]),
      }),
    ]);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.events.length).toBe(1);
    const e = body.events[0];
    expect(e.type).toBe("onboarding");
    expect(e.daemon_event_id).toBe("onb-legacy-1");
    expect(e.session_id).toBeUndefined();
    expect(e.step_name).toBeUndefined();
    expect(e.step_index).toBeUndefined();
    expect(e.completed_at).toBeUndefined();
    expect(e.funnel_version).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Tool-executed events
  // -------------------------------------------------------------------------

  test("tool_executed events project decision to status and never carry raw args/results", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    seedToolInvocation({
      id: "ti-ok",
      createdAt: 1700000001000,
      toolName: "calendar_list_events",
      decision: "allow",
      durationMs: 12,
      argBytes: 42,
      resultBytes: 9001,
      provider: "anthropic",
      model: "model-a",
      inferenceProfile: "balanced",
      inferenceProfileSource: "active",
    });
    // Errored invocation without LLM attribution — the attribution columns
    // are null and must pass through as null.
    seedToolInvocation({
      id: "ti-err",
      createdAt: 1700000002000,
      toolName: "web_search",
      decision: "error",
      durationMs: 7,
      argBytes: 17,
      resultBytes: 33,
    });
    // Permission-denied rows are filtered in the store and must never ship.
    seedToolInvocation({
      id: "ti-denied",
      createdAt: 1700000003000,
      decision: "denied",
    });
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":2}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const rawBody = (mockFetch.mock.calls[0] as [string, RequestInit])[1]
      .body as string;
    // ToS/PII contract: raw tool args/outputs never leave the device.
    expect(rawBody).not.toContain(TOOL_PII_SENTINEL);

    const body = JSON.parse(rawBody);
    expect(body.events.length).toBe(2);

    const byId: Record<string, Record<string, unknown>> = {};
    for (const e of body.events as Array<{ daemon_event_id: string }>) {
      byId[e.daemon_event_id] = e;
    }

    expect(byId["ti-ok"]).toEqual({
      type: "tool_executed",
      daemon_event_id: "ti-ok",
      recorded_at: 1700000001000,
      tool_name: "calendar_list_events",
      status: "fulfilled",
      duration_ms: 12,
      arg_bytes: 42,
      result_bytes: 9001,
      conversation_id: TOOL_CONVERSATION_ID,
      provider: "anthropic",
      model: "model-a",
      inference_profile: "balanced",
      inference_profile_source: "active",
      assistant_version: "1.2.3-test",
    });
    expect(byId["ti-err"]).toMatchObject({
      type: "tool_executed",
      tool_name: "web_search",
      status: "errored",
      duration_ms: 7,
      arg_bytes: 17,
      result_bytes: 33,
      provider: null,
      model: null,
      inference_profile: null,
      inference_profile_source: null,
    });
    expect(byId["ti-denied"]).toBeUndefined();
  });

  test("tool_executed watermark advances to the last reported row on success", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    seedToolInvocation({ id: "ti-w1", createdAt: 1700000001000 });
    seedToolInvocation({ id: "ti-w2", createdAt: 1700000002000 });
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":2}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    const watermarkCalls = mockSetFlushCheckpoint.mock.calls.filter(
      (c) => c[0] === "telemetry:tool_executed:last_reported_at",
    );
    expect(watermarkCalls.length).toBeGreaterThanOrEqual(1);
    expect(watermarkCalls[watermarkCalls.length - 1][1]).toBe(
      String(1700000002000),
    );

    const idCalls = mockSetFlushCheckpoint.mock.calls.filter(
      (c) => c[0] === "telemetry:tool_executed:last_reported_id",
    );
    expect(idCalls.length).toBeGreaterThanOrEqual(1);
    expect(idCalls[idCalls.length - 1][1]).toBe("ti-w2");
  });

  test("tool_executed resumes from a stored watermark — reported rows are not re-shipped", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    seedToolInvocation({ id: "ti-r1", createdAt: 1700000001000 });
    seedToolInvocation({ id: "ti-r2", createdAt: 1700000002000 });
    // A previous flush already reported ti-r1.
    mockGetFlushCheckpoint.mockImplementation((key) => {
      if (key === "telemetry:tool_executed:last_reported_at") {
        return String(1700000001000);
      }
      if (key === "telemetry:tool_executed:last_reported_id") {
        return "ti-r1";
      }
      return null;
    });
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(
      body.events.map((e: { daemon_event_id: string }) => e.daemon_event_id),
    ).toEqual(["ti-r2"]);
  });

  test("rows recorded after construction but before the first flush are shipped", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    // Regression coverage for the review finding: the reporter delays its
    // first flush by 30s+, so a tool used right after daemon startup is
    // recorded before any flush has run. The construction-time watermark
    // init must not drop it — only rows from before construction (rows
    // predating the reporter) stay behind the watermark.
    const checkpoints = useStatefulCheckpoints();

    const reporter = makeReporter();
    const rowCreatedAt =
      Number(checkpoints.get("telemetry:tool_executed:last_reported_at")) +
      1000;
    seedToolInvocation({ id: "ti-pre-first-flush", createdAt: rowCreatedAt });

    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.events.length).toBe(1);
    expect(body.events[0]).toMatchObject({
      type: "tool_executed",
      daemon_event_id: "ti-pre-first-flush",
      recorded_at: rowCreatedAt,
    });

    // The watermark advances to the shipped row, so the next flush resumes
    // after it instead of re-shipping.
    expect(checkpoints.get("telemetry:tool_executed:last_reported_at")).toBe(
      String(rowCreatedAt),
    );
  });

  test("absent tool_executed checkpoint is initialized at construction — rows predating the reporter never ship", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    const checkpoints = useStatefulCheckpoints();

    // Rows accumulated before any flush ever advanced the watermark — e.g.
    // an opt-out period under an older build that gated reporter
    // construction on the usage-data opt-out while the always-on audit
    // listener kept writing.
    seedToolInvocation({
      id: "ti-opt-out-window",
      createdAt: Date.now() - 60_000,
    });

    const reporter = makeReporter();

    // The checkpoint is persisted immediately at construction so a crash
    // before the first flush can't re-initialize later.
    const initialized = checkpoints.get(
      "telemetry:tool_executed:last_reported_at",
    );
    expect(initialized).toBeDefined();

    // A tool that runs after construction ships normally.
    seedToolInvocation({
      id: "ti-post-construction",
      createdAt: Number(initialized) + 1000,
    });

    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(
      body.events.map((e: { daemon_event_id: string }) => e.daemon_event_id),
    ).toEqual(["ti-post-construction"]);
  });

  test("existing tool_executed checkpoint is respected — construction does not re-initialize", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    const checkpoints = useStatefulCheckpoints({
      "telemetry:tool_executed:last_reported_at": String(1700000001000),
      "telemetry:tool_executed:last_reported_id": "ti-already-reported",
    });

    seedToolInvocation({
      id: "ti-already-reported",
      createdAt: 1700000001000,
    });
    // Legitimate backlog past the stored watermark — a re-initialization to
    // Date.now() at construction would silently drop it. Rows past the
    // watermark are always legitimately shippable: opted-out sessions keep
    // the watermark advancing via the opt-out flush branch (the reporter
    // runs even when collection is disabled), so the backlog can only hold
    // opted-in rows.
    seedToolInvocation({ id: "ti-backlog", createdAt: 1700000002000 });

    const reporter = makeReporter();
    expect(checkpoints.get("telemetry:tool_executed:last_reported_at")).toBe(
      String(1700000001000),
    );

    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(
      body.events.map((e: { daemon_event_id: string }) => e.daemon_event_id),
    ).toEqual(["ti-backlog"]);
  });

  test("opt-out window never ships across restarts — opted-out flushes keep the watermark ahead of audit rows", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    // A previous opted-in session shipped through this watermark.
    const checkpoints = useStatefulCheckpoints({
      "telemetry:tool_executed:last_reported_at": String(1700000001000),
      "telemetry:tool_executed:last_reported_id": "ti-shipped-opted-in",
    });

    // Session 1: the user opted out and restarted. The daemon still
    // constructs and runs the reporter; the always-on audit listener keeps
    // writing rows. Every opted-out flush (5-minute cycle plus the final
    // flush in stop()) advances the watermark past them without sending.
    mockGetCachedShareAnalytics.mockReturnValue(false);
    const optOutRowCreatedAt = Date.now() - 5_000;
    seedToolInvocation({
      id: "ti-opt-out-window",
      createdAt: optOutRowCreatedAt,
    });
    const optedOutReporter = makeReporter();
    await optedOutReporter.stop(); // shutdown path: runs the final flush
    expect(mockFetch).not.toHaveBeenCalled();
    const advanced = Number(
      checkpoints.get("telemetry:tool_executed:last_reported_at"),
    );
    expect(advanced).toBeGreaterThan(optOutRowCreatedAt);

    // Session 2: the user opts back in and restarts. Only rows recorded
    // after the opt-out epoch ship — the opt-out-window row never does.
    mockGetCachedShareAnalytics.mockReturnValue(true);
    seedToolInvocation({ id: "ti-after-opt-in", createdAt: advanced + 1000 });
    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(
      body.events.map((e: { daemon_event_id: string }) => e.daemon_event_id),
    ).toEqual(["ti-after-opt-in"]);
  });

  test("opt-out row written in the same millisecond as the opt-out flush never ships after re-opt-in", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    // A previous opted-in session left a low-sorting ID watermark behind.
    const checkpoints = useStatefulCheckpoints({
      "telemetry:tool_executed:last_reported_at": String(1700000001000),
      "telemetry:tool_executed:last_reported_id":
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    });

    // Opted-out flush: advances the timestamp watermark to Date.now() and
    // must also pin the ID watermark to the high-sorting sentinel.
    mockGetCachedShareAnalytics.mockReturnValue(false);
    const optedOutReporter = makeReporter();
    await optedOutReporter.flush();
    expect(mockFetch).not.toHaveBeenCalled();
    const watermark = Number(
      checkpoints.get("telemetry:tool_executed:last_reported_at"),
    );

    // An audit row written in the SAME millisecond as the opt-out flush's
    // Date.now(), with a UUID sorting above the stale pre-opt-out ID
    // watermark. With only the timestamp watermark advanced, the compound
    // cursor's `createdAt == watermark AND id > afterId` arm would match it.
    seedToolInvocation({
      id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      createdAt: watermark,
    });

    // Re-opt-in: only rows strictly after the opt-out epoch ship.
    mockGetCachedShareAnalytics.mockReturnValue(true);
    seedToolInvocation({ id: "ti-after-opt-in", createdAt: watermark + 1000 });
    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(
      body.events.map((e: { daemon_event_id: string }) => e.daemon_event_id),
    ).toEqual(["ti-after-opt-in"]);
  });

  test("a turn-only (daemon) reporter never touches the tool_executed watermark", () => {
    new UsageTelemetryReporter(
      DAEMON_TELEMETRY_EVENT_SOURCES,
      fakeFlushCheckpointStore,
    );
    expect(mockGetFlushCheckpoint).not.toHaveBeenCalled();
    expect(mockSetFlushCheckpoint).not.toHaveBeenCalled();
  });

  test("a monitor reporter re-runs the guarded tool_executed watermark init as a backstop", () => {
    new UsageTelemetryReporter(
      MONITOR_TELEMETRY_EVENT_SOURCES,
      fakeFlushCheckpointStore,
    );
    expect(mockGetFlushCheckpoint).toHaveBeenCalledWith(
      "telemetry:tool_executed:last_reported_at",
    );
    expect(mockSetFlushCheckpoint).toHaveBeenCalledTimes(1);
  });

  test("initToolExecutedWatermarkIfAbsent sets the epoch once and never overwrites", () => {
    const checkpoints = useStatefulCheckpoints();
    initToolExecutedWatermarkIfAbsent(fakeFlushCheckpointStore);
    const epoch = checkpoints.get("telemetry:tool_executed:last_reported_at");
    expect(epoch).toBeString();

    initToolExecutedWatermarkIfAbsent(fakeFlushCheckpointStore);
    expect(checkpoints.get("telemetry:tool_executed:last_reported_at")).toBe(
      epoch!,
    );

    // A store failure is non-fatal (degraded-DB daemons still start).
    mockGetFlushCheckpoint.mockImplementation(() => {
      throw new Error("database disk image is malformed");
    });
    expect(() =>
      initToolExecutedWatermarkIfAbsent(fakeFlushCheckpointStore),
    ).not.toThrow();
  });

  test("checkpoint store failure during construction is non-fatal — degraded-DB daemons still start", () => {
    // initializeDb() failures are tolerated at daemon startup (degraded
    // mode), so the constructor's checkpoint init must never throw out of
    // the constructor and abort the daemon.
    mockGetFlushCheckpoint.mockImplementation(() => {
      throw new Error("database disk image is malformed");
    });
    expect(() => makeReporter()).not.toThrow();

    // The write path failing is equally non-fatal.
    mockGetFlushCheckpoint.mockImplementation(() => null);
    mockSetFlushCheckpoint.mockImplementation(() => {
      throw new Error("database disk image is malformed");
    });
    expect(() => makeReporter()).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Skill-loaded events
  // -------------------------------------------------------------------------

  test("skill_loaded events ship metadata with attribution and null passthrough", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    recordSkillLoadedEvent({
      conversationId: "conv-skill",
      skillName: "web-research",
      skillUpdatedAt: "2026-06-01T00:00:00.000Z",
      provider: "anthropic",
      model: "model-a",
      inferenceProfile: "balanced",
      inferenceProfileSource: "active",
    });
    // Minimal record — optional fields persist as null and ship as null.
    recordSkillLoadedEvent({ skillName: "tasks" });
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":2}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.events.length).toBe(2);

    const byName: Record<string, Record<string, unknown>> = {};
    for (const e of body.events as Array<{ skill_name: string }>) {
      byName[e.skill_name] = e;
    }

    expect(byName["web-research"]).toMatchObject({
      type: "skill_loaded",
      skill_name: "web-research",
      skill_updated_at: "2026-06-01T00:00:00.000Z",
      conversation_id: "conv-skill",
      provider: "anthropic",
      model: "model-a",
      inference_profile: "balanced",
      inference_profile_source: "active",
      assistant_version: "1.2.3-test",
    });
    expect(typeof byName["web-research"].daemon_event_id).toBe("string");
    expect(typeof byName["web-research"].recorded_at).toBe("number");
    expect(byName["tasks"]).toMatchObject({
      type: "skill_loaded",
      skill_name: "tasks",
      skill_updated_at: null,
      conversation_id: null,
      provider: null,
      model: null,
      inference_profile: null,
      inference_profile_source: null,
    });
  });

  test("skill_loaded watermark advances to the last reported row on success", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    recordSkillLoadedEvent({ skillName: "web-research" });
    recordSkillLoadedEvent({ skillName: "tasks" });
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":2}', { status: 200 })),
    );

    // The last row by the reporter's (createdAt, id) cursor order is the one
    // whose watermark should be persisted after a successful upload.
    const rows = getTelemetryDb()!
      .select()
      .from(skillLoadedEvents)
      .orderBy(skillLoadedEvents.createdAt, skillLoadedEvents.id)
      .all();
    const lastRow = rows[rows.length - 1];

    const reporter = makeReporter();
    await reporter.flush();

    const watermarkCalls = mockSetFlushCheckpoint.mock.calls.filter(
      (c) => c[0] === "telemetry:skill_loaded:last_reported_at",
    );
    expect(watermarkCalls.length).toBeGreaterThanOrEqual(1);
    expect(watermarkCalls[watermarkCalls.length - 1][1]).toBe(
      String(lastRow.createdAt),
    );

    const idCalls = mockSetFlushCheckpoint.mock.calls.filter(
      (c) => c[0] === "telemetry:skill_loaded:last_reported_id",
    );
    expect(idCalls.length).toBeGreaterThanOrEqual(1);
    expect(idCalls[idCalls.length - 1][1]).toBe(lastRow.id);
  });

  test("batch recursion when skill_loaded returns a full batch, capped at 10", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    // Exactly BATCH_SIZE rows; the mocked checkpoints never persist, so each
    // recursion re-reads the same full batch until the cap.
    const fullBatch = Array.from({ length: 500 }, (_, i) => ({
      id: `sle-batch-${String(i).padStart(3, "0")}`,
      createdAt: 1700000000000 + i,
      skillName: "web-research",
    }));
    getTelemetryDb()!.insert(skillLoadedEvents).values(fullBatch).run();
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":500}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    // MAX_CONSECUTIVE_BATCHES = 10
    expect(mockFetch).toHaveBeenCalledTimes(10);
  });

  // -------------------------------------------------------------------------
  // Config-setting events
  // -------------------------------------------------------------------------

  test("config_setting events ship the key/value pair on the standard envelope", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    recordConfigSettingEvent({
      configKey: "memory.enabled",
      configValue: "true",
    });
    recordConfigSettingEvent({
      configKey: "memory.v2.enabled",
      configValue: "false",
    });
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":2}', { status: 200 })),
    );

    const reporter = makeReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.events.length).toBe(2);

    const byKey: Record<string, Record<string, unknown>> = {};
    for (const e of body.events as Array<{ config_key: string }>) {
      byKey[e.config_key] = e;
    }

    expect(byKey["memory.enabled"]).toMatchObject({
      type: "config_setting",
      config_key: "memory.enabled",
      config_value: "true",
      assistant_version: "1.2.3-test",
    });
    expect(typeof byKey["memory.enabled"].daemon_event_id).toBe("string");
    expect(typeof byKey["memory.enabled"].recorded_at).toBe("number");
    expect(byKey["memory.v2.enabled"]).toMatchObject({
      type: "config_setting",
      config_key: "memory.v2.enabled",
      config_value: "false",
    });
  });

  test("config_setting watermark advances to the last reported row on success", async () => {
    mockQueryUnreportedUsageEvents.mockReturnValue([]);
    recordConfigSettingEvent({
      configKey: "memory.enabled",
      configValue: "true",
    });
    recordConfigSettingEvent({
      configKey: "memory.v2.enabled",
      configValue: "true",
    });
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":2}', { status: 200 })),
    );

    // The last row by the reporter's (createdAt, id) cursor order is the one
    // whose watermark should be persisted after a successful upload.
    const rows = getTelemetryDb()!
      .select()
      .from(configSettingEvents)
      .orderBy(configSettingEvents.createdAt, configSettingEvents.id)
      .all();
    const lastRow = rows[rows.length - 1];

    const reporter = makeReporter();
    await reporter.flush();

    const watermarkCalls = mockSetFlushCheckpoint.mock.calls.filter(
      (c) => c[0] === "telemetry:config_setting:last_reported_at",
    );
    expect(watermarkCalls.length).toBeGreaterThanOrEqual(1);
    expect(watermarkCalls[watermarkCalls.length - 1][1]).toBe(
      String(lastRow.createdAt),
    );

    const idCalls = mockSetFlushCheckpoint.mock.calls.filter(
      (c) => c[0] === "telemetry:config_setting:last_reported_id",
    );
    expect(idCalls.length).toBeGreaterThanOrEqual(1);
    expect(idCalls[idCalls.length - 1][1]).toBe(lastRow.id);
  });
});
