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
    accent_hex: string;
    muted: boolean;
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
const { changeLocale } = await import("@/i18n");

beforeEach(() => {
  lastUpsertArg = null;
  resolveSignedApnsEnvironmentMock.mockClear();
  getInfoMock.mockClear();
  upsertMock.mockClear();
  deleteMock.mockClear();
  captureErrorMock.mockClear();
  localStorage.removeItem("vellum:live_activity_registration");
});

const REGISTRATION = {
  token: "activity-token",
  assistantId: "assistant-1",
  conversationId: "conv-1",
  accentHex: "#FF8800",
  muted: false,
};

describe("registerLiveActivityPushToken APNs environment", () => {
  test("tags the upsert with the shared resolver's environment", async () => {
    await registerLiveActivityPushToken(REGISTRATION);

    expect(resolveSignedApnsEnvironmentMock).toHaveBeenCalledWith(bundleId);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(lastUpsertArg?.path).toEqual({ assistant_id: "assistant-1" });
    expect(lastUpsertArg?.body.token).toBe("activity-token");
    expect(lastUpsertArg?.body.bundle_id).toBe(bundleId);
    expect(lastUpsertArg?.body.conversation_id).toBe("conv-1");
    expect(lastUpsertArg?.body.apns_environment).toBe("production");
  });
});

describe("registerLiveActivityPushToken content state", () => {
  // The daemon that drives the server-side pushes observes neither, so the
  // registration is the only path either has into a pushed content state.
  test("carries the accent and mute state the daemon cannot see", async () => {
    await registerLiveActivityPushToken({
      ...REGISTRATION,
      accentHex: "#22CC99",
      muted: true,
    });

    expect(lastUpsertArg?.body.accent_hex).toBe("#22CC99");
    expect(lastUpsertArg?.body.muted).toBe(true);
  });

  /**
   * The platform composes each push by looking a phase up in this map, so a
   * table built as if the mic were live would push "Listening…" over the local
   * "Muted" on the first phase change after iOS suspends the web view, which
   * is the only state the island is ever seen in.
   */
  test("bakes the mute state into the pushed label table", async () => {
    await registerLiveActivityPushToken({ ...REGISTRATION, muted: true });

    expect(lastUpsertArg?.body.labels.listening).toBe("Muted");
    // The assistant's own phases are unaffected by a muted mic.
    expect(lastUpsertArg?.body.labels.thinking).toBe("Thinking…");
  });

  test("pushes the listening label unmuted when the mic is live", async () => {
    await registerLiveActivityPushToken({ ...REGISTRATION, muted: false });

    expect(lastUpsertArg?.body.labels.listening).toBe("Listening…");
  });

  /**
   * The table is the platform's whole vocabulary, so one built in English puts
   * the island back into English on the first push after iOS suspends this web
   * layer, which is the only state the island is ever seen in.
   */
  test("registers the table in the language the app is in", async () => {
    await changeLocale("es");
    try {
      await registerLiveActivityPushToken(REGISTRATION);

      expect(lastUpsertArg?.body.labels.listening).toBe("Escuchando…");
      expect(lastUpsertArg?.body.labels.thinking).toBe("Pensando…");
    } finally {
      // Process-global, so leaving it set would fail every later assertion.
      await changeLocale("en");
    }
  });

  // The stored row is what every background push composes from, so a slow
  // first request landing after a fast second one would leave the island
  // rendering the state the user moved away from.
  test("registrations reach the platform in call order", async () => {
    const arrived: boolean[] = [];
    let releaseFirst!: () => void;
    const firstInFlight = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    upsertMock.mockImplementation(async (arg: UpsertArg) => {
      lastUpsertArg = arg;
      calls += 1;
      // Hold the first request open past the point the second is issued, so
      // an unserialized implementation would let the second overtake it.
      if (calls === 1) {
        await firstInFlight;
      }
      arrived.push(arg.body.muted);
      return { data: {}, error: undefined };
    });

    const first = registerLiveActivityPushToken({
      ...REGISTRATION,
      muted: true,
    });
    const second = registerLiveActivityPushToken({
      ...REGISTRATION,
      muted: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseFirst();
    await Promise.all([first, second]);

    expect(arrived).toEqual([true, false]);
    expect(lastUpsertArg?.body.muted).toBe(false);
  });
});
