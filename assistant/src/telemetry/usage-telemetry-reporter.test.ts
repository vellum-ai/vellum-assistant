/**
 * Tests for UsageTelemetryReporter.
 *
 * Covers both auth modes (authenticated / anonymous), watermark advancement,
 * error handling, batch recursion, installation ID persistence, and payload shape.
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

const mockResolveManagedProxyContext = mock(async () => ({
  enabled: false,
  platformBaseUrl: "",
  assistantApiKey: "",
}));

mock.module("../providers/managed-proxy/context.js", () => ({
  resolveManagedProxyContext: mockResolveManagedProxyContext,
}));

const mockGetTelemetryPlatformUrl = mock(() => "https://platform.vellum.ai");
const mockGetTelemetryAppToken = mock(() => "");

mock.module("../config/env.js", () => ({
  getTelemetryPlatformUrl: mockGetTelemetryPlatformUrl,
  getTelemetryAppToken: mockGetTelemetryAppToken,
  // Re-export anything else the module might import transitively
  str: () => undefined,
  num: () => undefined,
  bool: () => false,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ---------------------------------------------------------------------------
// Production import (after mocks)
// ---------------------------------------------------------------------------

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
  mockGetMemoryCheckpoint.mockReset();
  mockSetMemoryCheckpoint.mockReset();
  mockQueryUnreportedUsageEvents.mockReset();
  mockResolveManagedProxyContext.mockReset();
  mockGetTelemetryPlatformUrl.mockReset();
  mockGetTelemetryAppToken.mockReset();

  // Defaults
  mockGetMemoryCheckpoint.mockReturnValue(null);
  mockResolveManagedProxyContext.mockResolvedValue({
    enabled: false,
    platformBaseUrl: "",
    assistantApiKey: "",
  });
  mockGetTelemetryPlatformUrl.mockReturnValue("https://platform.vellum.ai");
  mockGetTelemetryAppToken.mockReturnValue("default-test-token");

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
  test("authenticated flush uses Api-Key header and proxy URL", async () => {
    mockResolveManagedProxyContext.mockResolvedValue({
      enabled: true,
      platformBaseUrl: "https://test.vellum.ai",
      assistantApiKey: "test-key",
    });
    const events = [makeUsageEvent(), makeUsageEvent()];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(`{"accepted":${events.length}}`, { status: 200 }),
      ),
    );

    const reporter = new UsageTelemetryReporter();
    await reporter.flush();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://test.vellum.ai/v1/assistants/self-hosted-local/telemetry/usage/",
    );
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe(
      "Api-Key test-key",
    );
  });

  test("anonymous flush uses X-Telemetry-Token and default URL", async () => {
    mockResolveManagedProxyContext.mockResolvedValue({
      enabled: false,
      platformBaseUrl: "",
      assistantApiKey: "",
    });
    mockGetTelemetryPlatformUrl.mockReturnValue("https://platform.test.ai");
    mockGetTelemetryAppToken.mockReturnValue("anon-token");

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
    expect((opts.headers as Record<string, string>)["X-Telemetry-Token"]).toBe(
      "anon-token",
    );
  });

  test("watermark advances on successful upload", async () => {
    const events = [
      makeUsageEvent({ createdAt: 1700000001000 }),
      makeUsageEvent({ createdAt: 1700000002000 }),
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

  test("installation ID generated on first flush, reused thereafter", async () => {
    let storedInstallId: string | null = null;

    mockGetMemoryCheckpoint.mockImplementation((key: string) => {
      if (key === "telemetry:installation_id") return storedInstallId;
      return null;
    });
    mockSetMemoryCheckpoint.mockImplementation((key: string, value: string) => {
      if (key === "telemetry:installation_id") storedInstallId = value;
    });

    const events = [makeUsageEvent()];
    mockQueryUnreportedUsageEvents.mockReturnValue(events);
    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response('{"accepted":1}', { status: 200 })),
    );

    const reporter = new UsageTelemetryReporter();

    // First flush — should generate and store a new installation ID
    await reporter.flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body1 = JSON.parse(
      (mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string,
    );
    expect(body1.installation_id).toBeTruthy();
    expect(typeof body1.installation_id).toBe("string");

    // Second flush
    mockQueryUnreportedUsageEvents.mockReturnValue([makeUsageEvent()]);
    await reporter.flush();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const body2 = JSON.parse(
      (mockFetch.mock.calls[1] as [string, RequestInit])[1].body as string,
    );

    // Both flushes should use the same installation ID
    expect(body2.installation_id).toBe(body1.installation_id);
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

    // Top-level: installation_id and events array
    expect(typeof body.installation_id).toBe("string");
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events.length).toBe(1);

    const e = body.events[0];
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
});
