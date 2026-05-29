import { describe, expect, mock, test } from "bun:test";

let mockedPlatform = "web";

mock.module("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => mockedPlatform,
  },
}));

import { getDiagnosticsEvents, recordDiagnostic } from "@/lib/diagnostics";

// ---------------------------------------------------------------------------
// recordDiagnostic — centralized platform tag injection
//
// The idle-watchdog decision is platform-conditioned: iOS WKWebView
// silently stalls SSE connections, so a platform breakdown of watchdog
// fires is the data we actually need. The diagnostics module injects
// `platform` once at the SDK boundary (per the OpenTelemetry
// resource-attribute convention —
// https://opentelemetry.io/docs/specs/otel/resource/sdk/) so every
// caller gets it for free without per-call-site plumbing. These tests
// pin that contract and exercise the happy path under the mocked
// Capacitor module rather than the diagnostics module's defensive
// fallback.
// ---------------------------------------------------------------------------

describe("recordDiagnostic platform tag", () => {
  test("injects platform from Capacitor.getPlatform on every recorded event", () => {
    mockedPlatform = "ios";
    const eventCountBefore = getDiagnosticsEvents().length;

    recordDiagnostic("test_kind_a", { foo: "bar" });
    recordDiagnostic("test_kind_b", { baz: 1 });

    const newEvents = getDiagnosticsEvents().slice(eventCountBefore);
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
    const eventCountBefore = getDiagnosticsEvents().length;

    recordDiagnostic("test_kind_override", {
      platform: "explicit-override",
    });

    const newEvents = getDiagnosticsEvents().slice(eventCountBefore);
    expect(newEvents).toHaveLength(1);
    expect(newEvents[0]!.details.platform).toBe("explicit-override");
  });

  test("injects different platform values when Capacitor reports different surfaces", () => {
    const eventCountBefore = getDiagnosticsEvents().length;

    mockedPlatform = "android";
    recordDiagnostic("test_kind_android");
    mockedPlatform = "web";
    recordDiagnostic("test_kind_web");

    const newEvents = getDiagnosticsEvents().slice(eventCountBefore);
    expect(newEvents).toHaveLength(2);
    expect(newEvents[0]!.details.platform).toBe("android");
    expect(newEvents[1]!.details.platform).toBe("web");
  });
});
