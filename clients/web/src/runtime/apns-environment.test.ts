/**
 * Fallback matrix for `resolveSignedApnsEnvironment`: the signing-derived
 * plugin result wins when readable, the bundle-suffix heuristic covers
 * `"unknown"` entitlements and pre-plugin shells whose bridge call rejects.
 * Consumers (`push-registration.test.ts`,
 * `live-activity-push-registration.test.ts`) mock this module and only pin
 * their upsert wiring to it.
 */

import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

// ── ApnsEnvironment (module-scope registerPlugin bridge) ─────────────────────
//
// The default simulates an old shell without the plugin (bridge call rejects).
// Signing-derived cases set `apnsEnvironmentRejects = false` and an explicit
// `apnsEnvironmentResult`.

let apnsEnvironmentResult: string | undefined;
let apnsEnvironmentRejects = true;
const apnsEnvironmentGetMock = mock(
  async (): Promise<{ environment?: string }> => {
    if (apnsEnvironmentRejects) {
      throw new Error("ApnsEnvironment.get() is not implemented on ios");
    }
    return { environment: apnsEnvironmentResult };
  },
);

mock.module("@capacitor/core", () => ({
  registerPlugin: (name: string) =>
    name === "ApnsEnvironment" ? { get: apnsEnvironmentGetMock } : {},
}));

// ── Sentry capture-error ─────────────────────────────────────────────────────
//
// The module deliberately reports fallbacks via `console.debug` only (an old
// shell is an expected state, not a fault); the mock makes the no-capture
// assertion fail loudly if a future edit starts reporting them.

const captureErrorMock = mock(() => {});
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorMock,
}));

const { resolveSignedApnsEnvironment } =
  await import("@/runtime/apns-environment");

const consoleDebugSpy = spyOn(console, "debug").mockImplementation(() => {});

const DEV_BUNDLE_ID = "ai.vocify-inc.vellum-assistant-ios.dev";
const PROD_BUNDLE_ID = "ai.vocify-inc.vellum-assistant-ios";

beforeEach(() => {
  apnsEnvironmentResult = undefined;
  apnsEnvironmentRejects = true;
  apnsEnvironmentGetMock.mockClear();
  captureErrorMock.mockClear();
  consoleDebugSpy.mockClear();
});

describe("resolveSignedApnsEnvironment", () => {
  test("plugin production wins over a .dev bundle (TestFlight dev build)", async () => {
    apnsEnvironmentRejects = false;
    apnsEnvironmentResult = "production";

    expect(await resolveSignedApnsEnvironment(DEV_BUNDLE_ID)).toBe(
      "production",
    );
  });

  test("plugin development wins over a production-mapping bundle (Xcode install)", async () => {
    apnsEnvironmentRejects = false;
    apnsEnvironmentResult = "development";

    expect(await resolveSignedApnsEnvironment(PROD_BUNDLE_ID)).toBe(
      "development",
    );
  });

  test("unknown entitlement falls back to the bundle-suffix heuristic", async () => {
    apnsEnvironmentRejects = false;
    apnsEnvironmentResult = "unknown";

    expect(await resolveSignedApnsEnvironment(DEV_BUNDLE_ID)).toBe(
      "development",
    );
    expect(await resolveSignedApnsEnvironment(PROD_BUNDLE_ID)).toBe(
      "production",
    );
  });

  test("bridge rejection (old shell) falls back to the heuristic: console.debug, no Sentry capture", async () => {
    expect(await resolveSignedApnsEnvironment(DEV_BUNDLE_ID)).toBe(
      "development",
    );
    expect(await resolveSignedApnsEnvironment(PROD_BUNDLE_ID)).toBe(
      "production",
    );

    expect(apnsEnvironmentGetMock).toHaveBeenCalledTimes(2);
    expect(consoleDebugSpy).toHaveBeenCalledTimes(2);
    expect(captureErrorMock).not.toHaveBeenCalled();
  });
});
