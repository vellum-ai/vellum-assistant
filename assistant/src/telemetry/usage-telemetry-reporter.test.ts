/**
 * Tests for UsageTelemetryReporter.
 *
 * Covers both auth modes (authenticated / anonymous), watermark advancement,
 * error handling, batch recursion, device ID resolution, and payload shape.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks (must precede production imports)
// ---------------------------------------------------------------------------

const mockGetMemoryCheckpoint = mock<(key: string) => string | null>(
  () => null,
);
const mockSetMemoryCheckpoint = mock<(key: string, value: string) => void>(
  () => {},
);

mock.module("../memory/checkpoints.js", () => ({
  getMemoryCheckpoint: mockGetMemoryCheckpoint,
  setMemoryCheckpoint: mockSetMemoryCheckpoint,
}));

const mockQueryUnreportedUsageEvents = mock(
  () =>
    [] as ReturnType<
      typeof import("../memory/llm-usage-store.js").queryUnreportedUsageEvents
    >,
);

mock.module("../memory/llm-usage-store.js", () => ({
  queryUnreportedUsageEvents: mockQueryUnreportedUsageEvents,
}));

const mockQueryUnreportedTurnEvents = mock(
  () => [] as { id: string; createdAt: number }[],
);

mock.module("../memory/turn-events-store.js", () => ({
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

const mockGetExternalAssistantId = mock<() => string | undefined>(
  () => "test-assistant-id",
);

mock.module("../runtime/auth/external-assistant-id.js", () => ({
  getExternalAssistantId: mockGetExternalAssistantId,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../version.js", () => ({
  APP_VERSION: "1.2.3-test",
}));

let mockCollectUsageData = true;

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ collectUsageData: mockCollectUsageData }),
}));

const mockQueryUnreportedLifecycleEvents = mock(
  () => [] as { id: string; eventName: string; createdAt: number }[],
);

mock.module("../memory/lifecycle-events-store.js", () => ({
  queryUnreportedLifecycleEvents: mockQueryUnreportedLifecycleEvents,
}));

// ---------------------------------------------------------------------------
// Production import (after mocks)
// ---------------------------------------------------------------------------

import { DAEMON_INTERNAL_ASSISTANT_ID } from "../runtime/assistant-scope.js";
import type { UsageEvent } from "../usage/types.js";
import { UsageTelemetryReporter } from "./usage-telemetry-reporter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let eventIdCounter = 0;

function makeUsageEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
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
    actor: "main_agent",
    conversationId: "conv-1",
    runId: null,
    requestId: null,
    estimatedCostUsd: 0.001,
    pricingStatus: "priced",
    ...overrides,
  };
}

const originalFetch = globalThis.fetch;
let mockFetch: ReturnType<typeof mock>;

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  eventIdCounter = 0;
  mockCollectUsageData = true;
  mockGetMemoryCheckpoint.mockReset();
  mockSetMemoryCheckpoint.mockReset();
  mockQueryUnreportedUsageEvents.mockReset();
  mockQueryUnreportedTurnEvents.mockReset();
  mockQueryUnreportedTurnEvents.mockReturnValue([]);
  mockQueryUnreportedLifecycleEvents.mockReset();
  mockQueryUnreportedLifecycleEvents.mockReturnValue([]);
  mockPlatformClient = null;
  mockGetPlatformBaseUrl.mockReset();
  mockGetDeviceId.mockReset();
  mockGetDeviceId.mockReturnValue("test-device-id");
  mockGetExternalAssistantId.mockReset();
  mockGetExternalAssistantId.mockReturnValue("test-assistant-id");
  mockGetPlatformOrganizationId.mockReset();
  mockGetPlatformOrganizationId.mockReturnValue("");
  mockGetPlatformUserId.mockReset();
  mockGetPlatformUserId.mockReturnValue("");

  // Defaults
  mockGetMemoryCheckpoint.mockReturnValue(null);
  mockGetPlatformBaseUrl.mockReturnValue("https://platform.vellum.ai");

  mockFetch = mock(() =>
    Promise.resolve(new Response('{"accepted":0}', { status: 200 })),
  );
  globalThis.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
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

    const reporter = new UsageTelemetryReporter();
    await reporter.flush();

    expect(clientFetchMock).toHaveBeenCalledTimes(1);
    const [path] = clientFetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/v1/telemetry/ingest/");
    // globalThis.fetch should NOT have been called directly
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("anonymous flush sends request without auth headers", async () => {
    mockPlatformClient = null;
    mockGetPlatformBaseUrl.mockReturnValue("https://platform.test.ai");

    const events = [makeUsageEvent()];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = new UsageTelemetryReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toStartWith("https://platform.test.ai");
    expect(url).toEndWith("/telemetry/ingest/");
    const headers = opts.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Telemetry-Token"]).toBeUndefined();
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

    const reporter = new UsageTelemetryReporter();
    await reporter.flush();

    const watermarkCalls = mockSetMemoryCheckpoint.mock.calls.filter(
      (c) => c[0] === "telemetry:usage:last_reported_at",
    );
    expect(watermarkCalls.length).toBeGreaterThanOrEqual(1);
    // The watermark should be set to the createdAt of the last event
    expect(watermarkCalls[watermarkCalls.length - 1][1]).toBe(
      String(1700000002000),
    );

    // The compound cursor ID should also be set to the last event's id
    const idCalls = mockSetMemoryCheckpoint.mock.calls.filter(
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

    const reporter = new UsageTelemetryReporter();
    await reporter.flush();

    const watermarkCalls = mockSetMemoryCheckpoint.mock.calls.filter(
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

    const reporter = new UsageTelemetryReporter();

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

    const reporter = new UsageTelemetryReporter();
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

    const reporter = new UsageTelemetryReporter();
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

    const reporter = new UsageTelemetryReporter();
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
      createdAt: 1700000099000,
    });
    mockQueryUnreportedUsageEvents.mockReturnValue([event]);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = new UsageTelemetryReporter();
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
    expect(e.actor).toBe("context_compactor");
    expect(e.recorded_at).toBe(1700000099000);
  });

  test("organization_id and user_id included in payload when available", async () => {
    mockGetPlatformOrganizationId.mockReturnValue("org-123");
    mockGetPlatformUserId.mockReturnValue("user-456");
    const events = [makeUsageEvent()];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = new UsageTelemetryReporter();
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

    const reporter = new UsageTelemetryReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.organization_id).toBeUndefined();
    expect(body.user_id).toBeUndefined();
  });

  test("assistant_id falls back to DAEMON_INTERNAL_ASSISTANT_ID when getExternalAssistantId returns undefined", async () => {
    mockGetExternalAssistantId.mockReturnValue(undefined);
    const events = [makeUsageEvent()];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = new UsageTelemetryReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body.device_id).toBe("test-device-id");
    expect(body.assistant_id).toBe(DAEMON_INTERNAL_ASSISTANT_ID);
  });

  test("turn events are included in the events array with type discriminator", async () => {
    const usageEvent = makeUsageEvent({ id: "evt-mixed-usage" });
    mockQueryUnreportedUsageEvents.mockReturnValue([usageEvent]);
    mockQueryUnreportedTurnEvents.mockReturnValue([
      { id: "evt-mixed-turn", createdAt: 1700000050000 },
    ]);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":2}', { status: 200 })),
    );

    const reporter = new UsageTelemetryReporter();
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
  });

  test("flush is skipped and watermarks advanced when collectUsageData is false", async () => {
    mockCollectUsageData = false;
    const events = [makeUsageEvent()];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = new UsageTelemetryReporter();
    await reporter.flush();

    // No HTTP call should have been made
    expect(mockFetch).not.toHaveBeenCalled();

    // All 6 watermarks should have been advanced (3 timestamps + 3 IDs)
    expect(mockSetMemoryCheckpoint).toHaveBeenCalledTimes(6);

    const calls = mockSetMemoryCheckpoint.mock.calls;
    const keys = calls.map((c) => c[0]);
    expect(keys).toContain("telemetry:usage:last_reported_at");
    expect(keys).toContain("telemetry:usage:last_reported_id");
    expect(keys).toContain("telemetry:turns:last_reported_at");
    expect(keys).toContain("telemetry:turns:last_reported_id");
    expect(keys).toContain("telemetry:lifecycle:last_reported_at");
    expect(keys).toContain("telemetry:lifecycle:last_reported_id");
  });

  test("events sent normally after re-enabling collectUsageData", async () => {
    // First flush with opt-out — watermarks advance, nothing sent
    mockCollectUsageData = false;
    const reporter = new UsageTelemetryReporter();
    await reporter.flush();
    expect(mockFetch).not.toHaveBeenCalled();
    mockSetMemoryCheckpoint.mockReset();

    // Re-enable and flush with new events
    mockCollectUsageData = true;
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
});
