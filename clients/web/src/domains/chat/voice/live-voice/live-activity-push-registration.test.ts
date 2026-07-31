import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── APNs environment resolver ────────────────────────────────────────────────
//
// Mocked directly; the resolver's own fallback matrix is covered by
// runtime/apns-environment.test.ts. This file only pins the ActivityKit upsert
// wiring to the shared resolver.

const resolveSignedApnsEnvironmentMock = mock(
  async () => "production" as const,
);
mock.module("@/runtime/apns-environment", () => ({
  resolveSignedApnsEnvironment: resolveSignedApnsEnvironmentMock,
}));

// ── @capacitor/app (lazy-imported plugin Proxy) ──────────────────────────────

const bundleId = "ai.vocify-inc.vellum-assistant-ios";
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
  lastUpsertArg = null;
  resolveSignedApnsEnvironmentMock.mockClear();
  getInfoMock.mockClear();
  upsertMock.mockClear();
  deleteMock.mockClear();
  captureErrorMock.mockClear();
  localStorage.removeItem("vellum:live_activity_registration");
});

describe("registerLiveActivityPushToken APNs environment", () => {
  test("tags the upsert with the shared resolver's environment", async () => {
    await registerLiveActivityPushToken(
      "activity-token",
      "assistant-1",
      "conv-1",
    );

    expect(resolveSignedApnsEnvironmentMock).toHaveBeenCalledWith(bundleId);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(lastUpsertArg?.path).toEqual({ assistant_id: "assistant-1" });
    expect(lastUpsertArg?.body.token).toBe("activity-token");
    expect(lastUpsertArg?.body.bundle_id).toBe(bundleId);
    expect(lastUpsertArg?.body.conversation_id).toBe("conv-1");
    expect(lastUpsertArg?.body.apns_environment).toBe("production");
  });
});
