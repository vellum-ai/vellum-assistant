import { describe, expect, mock, test } from "bun:test";

let mockedPlatform = "web";

mock.module("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => mockedPlatform,
  },
}));

import {
  getChatDiagnosticsEvents,
  recordChatDiagnostic,
} from "@/domains/chat/utils/diagnostics";

// ---------------------------------------------------------------------------
// recordChatDiagnostic — centralized platform tag injection
//
// The L2/L3 watchdog decision is platform-conditioned: LUM-1431 was
// iOS-only, so a platform breakdown of watchdog fires is the data we
// actually need. The diagnostics module injects `platform` once at the
// SDK boundary (per the OpenTelemetry resource-attribute convention
// — https://opentelemetry.io/docs/specs/otel/resource/sdk/) so every
// caller gets it for free without per-call-site plumbing. These tests
// pin that contract and exercise the happy path under the mocked
// Capacitor module rather than the diagnostics module's defensive
// fallback.
// ---------------------------------------------------------------------------

describe("recordChatDiagnostic platform tag", () => {
  test("injects platform from Capacitor.getPlatform on every recorded event", () => {
    mockedPlatform = "ios";
    const eventCountBefore = getChatDiagnosticsEvents().length;

    recordChatDiagnostic("test_kind_a", { foo: "bar" });
    recordChatDiagnostic("test_kind_b", { baz: 1 });

    const newEvents = getChatDiagnosticsEvents().slice(eventCountBefore);
    expect(newEvents).toHaveLength(2);
    expect(newEvents[0]!.kind).toBe("test_kind_a");
    expect(newEvents[0]!.details.platform).toBe("ios");
    expect(newEvents[0]!.details.foo).toBe("bar");
    expect(newEvents[1]!.kind).toBe("test_kind_b");
    expect(newEvents[1]!.details.platform).toBe("ios");
    expect(newEvents[1]!.details.baz).toBe(1);

    mockedPlatform = "web";
  });

  test("call-site keys win over the injected platform tag", () => {
    const eventCountBefore = getChatDiagnosticsEvents().length;

    recordChatDiagnostic("test_kind_override", {
      platform: "explicit-override",
    });

    const newEvents = getChatDiagnosticsEvents().slice(eventCountBefore);
    expect(newEvents).toHaveLength(1);
    expect(newEvents[0]!.details.platform).toBe("explicit-override");
  });

  test("injects different platform values when Capacitor reports different surfaces", () => {
    const eventCountBefore = getChatDiagnosticsEvents().length;

    mockedPlatform = "android";
    recordChatDiagnostic("test_kind_android");
    mockedPlatform = "web";
    recordChatDiagnostic("test_kind_web");

    const newEvents = getChatDiagnosticsEvents().slice(eventCountBefore);
    expect(newEvents).toHaveLength(2);
    expect(newEvents[0]!.details.platform).toBe("android");
    expect(newEvents[1]!.details.platform).toBe("web");
  });
});
