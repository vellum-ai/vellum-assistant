import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── ApnsEnvironment (module-scope registerPlugin bridge) ─────────────────────
//
// The default simulates an old shell without the plugin (bridge call rejects),
// exercising the bundle-suffix heuristic fallback. Cases that exercise the
// signing-derived path set `apnsEnvironmentRejects = false` and an explicit
// `apnsEnvironmentResult`. Mirrors push-registration.test.ts, which covers the
// resolver's own matrix; these tests pin the ActivityKit upsert to it.

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

// ── @capacitor/app (lazy-imported plugin Proxy) ──────────────────────────────

let bundleId = "ai.vocify-inc.vellum-assistant-ios";
const getInfoMock = mock(async () => ({
  id: bundleId,
  name: "Vellum",
  build: "1",
  version: "1.0.0",
}));
mock.module("@capacitor/app", () => ({
  App: { getInfo: getInfoMock },
}));

// ── generated platform SDK ───────────────────────────────────────────────────

interface UpsertArg {
  path: { assistant_id: string };
  body: {
    token: string;
    bundle_id: string;
    apns_environment: string;
    conversation_id: string;
    labels: Record<string, string>;
  };
  throwOnError: boolean;
}

let lastUpsertArg: UpsertArg | null = null;
const upsertMock = mock(async (arg: UpsertArg) => {
  lastUpsertArg = arg;
  return { data: {}, error: undefined };
});
const deleteMock = mock(async () => ({ data: undefined, error: undefined }));
mock.module("@/generated/api/sdk.gen", () => ({
  assistantsLiveActivityTokensUpsert: upsertMock,
  assistantsLiveActivityTokensDelete: deleteMock,
}));

// ── Sentry capture-error ─────────────────────────────────────────────────────

const captureErrorMock = mock(() => {});
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorMock,
}));

const { registerLiveActivityPushToken } =
  await import("@/domains/chat/voice/live-voice/live-activity-push-registration");

beforeEach(() => {
  bundleId = "ai.vocify-inc.vellum-assistant-ios";
  apnsEnvironmentResult = undefined;
  apnsEnvironmentRejects = true;
  lastUpsertArg = null;
  apnsEnvironmentGetMock.mockClear();
  getInfoMock.mockClear();
  upsertMock.mockClear();
  deleteMock.mockClear();
  captureErrorMock.mockClear();
  localStorage.removeItem("vellum:live_activity_registration");
});

describe("registerLiveActivityPushToken APNs environment", () => {
  test("tags the token with the signing-derived environment: production on a .dev bundle (TestFlight dev build)", async () => {
    apnsEnvironmentRejects = false;
    apnsEnvironmentResult = "production";
    bundleId = "ai.vocify-inc.vellum-assistant-ios.dev";

    await registerLiveActivityPushToken(
      "activity-token-tf",
      "assistant-1",
      "conv-1",
    );

    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(lastUpsertArg?.path).toEqual({ assistant_id: "assistant-1" });
    expect(lastUpsertArg?.body.token).toBe("activity-token-tf");
    expect(lastUpsertArg?.body.bundle_id).toBe(
      "ai.vocify-inc.vellum-assistant-ios.dev",
    );
    expect(lastUpsertArg?.body.conversation_id).toBe("conv-1");
    expect(lastUpsertArg?.body.apns_environment).toBe("production");
  });

  test("falls back to the bundle-suffix heuristic when the bridge rejects (old shell), without a Sentry capture", async () => {
    apnsEnvironmentRejects = true;
    bundleId = "ai.vocify-inc.vellum-assistant-ios.dev";

    await registerLiveActivityPushToken(
      "activity-token-old",
      "assistant-1",
      "conv-2",
    );

    expect(apnsEnvironmentGetMock).toHaveBeenCalledTimes(1);
    expect(lastUpsertArg?.body.apns_environment).toBe("development");
    expect(captureErrorMock).not.toHaveBeenCalled();
  });
});
