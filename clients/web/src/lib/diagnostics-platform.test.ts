import { describe, expect, mock, test } from "bun:test";

let mockedOs = "web";

mock.module("@/runtime/platform-detection", () => ({
  detectClientOs: () => mockedOs,
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
// caller gets it for free without per-call-site plumbing.
//
// The tag is sourced from the SAME `detectClientOs()` the product `client_os`
// uses, so analytics and the assistant context agree and mobile-web (iOS /
// Android phone browsers) and the macOS app are distinguished — values the
// previous `Capacitor.getPlatform()` tag collapsed into `web`.
// ---------------------------------------------------------------------------

describe("recordDiagnostic platform tag", () => {
  test("injects platform from detectClientOs on every recorded event", () => {
    mockedOs = "ios";
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

    mockedOs = "web";
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

  test("tags each OS surface detectClientOs reports (incl. android & macos)", () => {
    const eventCountBefore = getDiagnosticsEvents().length;

    mockedOs = "android";
    recordDiagnostic("test_kind_android");
    mockedOs = "macos";
    recordDiagnostic("test_kind_macos");
    mockedOs = "web";
    recordDiagnostic("test_kind_web");

    const newEvents = getDiagnosticsEvents().slice(eventCountBefore);
    expect(newEvents).toHaveLength(3);
    expect(newEvents[0]!.details.platform).toBe("android");
    expect(newEvents[1]!.details.platform).toBe("macos");
    expect(newEvents[2]!.details.platform).toBe("web");
  });
});
