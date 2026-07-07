import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { subscribe } from "@/lib/event-bus";

// ── platform guards ──────────────────────────────────────────────────────────
//
// `native-auth` is mocked rather than loaded because its module-load
// `registerPlugin("NativeAuth")` would fail against the partial
// `@capacitor/core` mock (mirrors capacitor-app-state.test.ts).

let isNative = true;
let platform = "ios";
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => isNative,
}));
mock.module("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => isNative,
    getPlatform: () => platform,
  },
}));

// ── @capacitor/push-notifications (lazy-imported plugin Proxy) ────────────────

type RegistrationHandler = (token: { value: string }) => void;
type ErrorHandler = (error: { error: string }) => void;
type ActionPerformedHandler = (action: {
  actionId: string;
  notification: { data?: unknown };
}) => void;

let registrationHandler: RegistrationHandler | null = null;
let registrationErrorHandler: ErrorHandler | null = null;
let actionPerformedHandler: ActionPerformedHandler | null = null;
let permissionState: "granted" | "denied" | "prompt" = "granted";

const addListenerMock = mock(
  async (
    event: string,
    handler: RegistrationHandler | ErrorHandler | ActionPerformedHandler,
  ) => {
    if (event === "registration") {
      registrationHandler = handler as RegistrationHandler;
    } else if (event === "registrationError") {
      registrationErrorHandler = handler as ErrorHandler;
    } else if (event === "pushNotificationActionPerformed") {
      actionPerformedHandler = handler as ActionPerformedHandler;
    }
    return { remove: async () => {} };
  },
);
const requestPermissionsMock = mock(async () => ({ receive: permissionState }));
const registerMock = mock(async () => {});

mock.module("@capacitor/push-notifications", () => ({
  PushNotifications: {
    addListener: addListenerMock,
    requestPermissions: requestPermissionsMock,
    register: registerMock,
  },
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
//
// Capture call args via typed implementations rather than `.mock.calls` so the
// assertions stay type-safe (the mock's parameter type drives the captured
// shape).

interface UpsertArg {
  path: { assistant_id: string };
  body: {
    token: string;
    platform: string;
    bundle_id: string;
    apns_environment: string;
  };
  throwOnError: boolean;
}
interface DeleteArg {
  path: { assistant_id: string; token: string };
  query: { bundle_id: string };
  throwOnError: boolean;
}

let lastUpsertArg: UpsertArg | null = null;
let lastDeleteArg: DeleteArg | null = null;
let upsertError: unknown = undefined;
let deleteError: unknown = undefined;
// When set, the upsert blocks on this gate so a test can interleave logout
// with an in-flight upsert.
let upsertGate: Promise<void> | null = null;

const upsertMock = mock(async (arg: UpsertArg) => {
  if (upsertGate) await upsertGate;
  lastUpsertArg = arg;
  return { data: {}, error: upsertError };
});
const deleteMock = mock(async (arg: DeleteArg) => {
  lastDeleteArg = arg;
  return { data: undefined, error: deleteError };
});
mock.module("@/generated/api/sdk.gen", () => ({
  assistantsPushTokensUpsert: upsertMock,
  assistantsPushTokensDelete: deleteMock,
}));

// ── Sentry capture-error ─────────────────────────────────────────────────────

const captureErrorMock = mock(() => {});
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorMock,
}));

const {
  extractPushConversationId,
  isRemotePushSupported,
  registerForRemotePush,
  unregisterFromRemotePush,
  __resetPushRegistrationStateForTests,
} = await import("@/runtime/push-registration");

// The `registration` handler fires `upsertToken` fire-and-forget, and its
// dynamic `import("@capacitor/app")` resolves on the macrotask queue — yield to
// timers (not just microtasks) so the upsert settles before assertions.
const flushMicrotasks = async (rounds = 10) => {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

// Bus subscriptions made by a test; unsubscribed in afterEach so cases
// stay isolated.
const busUnsubscribes: Array<() => void> = [];
const subscribeForTest: typeof subscribe = (event, handler) => {
  const unsubscribe = subscribe(event, handler);
  busUnsubscribes.push(unsubscribe);
  return unsubscribe;
};

afterEach(() => {
  for (const unsubscribe of busUnsubscribes) {
    unsubscribe();
  }
  busUnsubscribes.length = 0;
});

beforeEach(() => {
  isNative = true;
  platform = "ios";
  permissionState = "granted";
  bundleId = "ai.vocify-inc.vellum-assistant-ios";
  registrationHandler = null;
  registrationErrorHandler = null;
  actionPerformedHandler = null;
  lastUpsertArg = null;
  lastDeleteArg = null;
  upsertError = undefined;
  deleteError = undefined;
  upsertGate = null;
  addListenerMock.mockClear();
  requestPermissionsMock.mockClear();
  registerMock.mockClear();
  getInfoMock.mockClear();
  upsertMock.mockClear();
  deleteMock.mockClear();
  captureErrorMock.mockClear();
  __resetPushRegistrationStateForTests();
});

describe("isRemotePushSupported", () => {
  test("true on native iOS", () => {
    expect(isRemotePushSupported()).toBe(true);
  });

  test("false off native (desktop browser / Electron)", () => {
    isNative = false;
    expect(isRemotePushSupported()).toBe(false);
  });

  test("false on a non-iOS native platform (e.g. android)", () => {
    platform = "android";
    expect(isRemotePushSupported()).toBe(false);
  });
});

describe("registerForRemotePush", () => {
  test("no-ops off native iOS — never touches the plugin or SDK", async () => {
    isNative = false;
    await registerForRemotePush("assistant-1");
    await flushMicrotasks();

    expect(requestPermissionsMock).not.toHaveBeenCalled();
    expect(registerMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  test("requests permission, registers, and upserts the token on registration", async () => {
    await registerForRemotePush("assistant-1");

    expect(requestPermissionsMock).toHaveBeenCalledTimes(1);
    expect(registerMock).toHaveBeenCalledTimes(1);

    // Simulate iOS delivering the APNs token.
    registrationHandler?.({ value: "apns-token-abc" });
    await flushMicrotasks();

    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(lastUpsertArg).toEqual({
      path: { assistant_id: "assistant-1" },
      body: {
        token: "apns-token-abc",
        platform: "ios",
        bundle_id: "ai.vocify-inc.vellum-assistant-ios",
        apns_environment: "production",
      },
      throwOnError: false,
    });
  });

  test("derives the development APNs environment from a .dev bundle id", async () => {
    bundleId = "ai.vocify-inc.vellum-assistant-ios.dev";
    await registerForRemotePush("assistant-1");
    registrationHandler?.({ value: "apns-token-dev" });
    await flushMicrotasks();

    expect(lastUpsertArg?.body.apns_environment).toBe("development");
  });

  test("does not register when notification permission is denied", async () => {
    permissionState = "denied";
    await registerForRemotePush("assistant-1");
    await flushMicrotasks();

    expect(registerMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  test("reports an upsert error to Sentry instead of throwing", async () => {
    upsertError = { detail: "boom" };
    await registerForRemotePush("assistant-1");
    registrationHandler?.({ value: "apns-token-abc" });
    await flushMicrotasks();

    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });

  test("registrationError from APNs is reported, not thrown", async () => {
    await registerForRemotePush("assistant-1");
    registrationErrorHandler?.({ error: "APNs failed" });
    await flushMicrotasks();

    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).not.toHaveBeenCalled();
  });
});

describe("pushNotificationActionPerformed tap routing", () => {
  const tap = (data?: unknown) => {
    actionPerformedHandler?.({ actionId: "tap", notification: { data } });
  };

  let published: Array<{ threadId: string }> = [];
  beforeEach(() => {
    published = [];
    subscribeForTest("deeplink.openThread", (payload) => {
      published.push(payload);
    });
  });

  test("publishes deeplink.openThread from data.deep_link.conversationId", async () => {
    await registerForRemotePush("assistant-1");
    tap({ deep_link: { conversationId: "conv-123" } });

    expect(published).toEqual([{ threadId: "conv-123" }]);
  });

  test("falls back to a top-level data.conversationId", async () => {
    await registerForRemotePush("assistant-1");
    tap({ conversationId: "conv-456" });

    expect(published).toEqual([{ threadId: "conv-456" }]);
  });

  test("publishes nothing for absent or malformed data", async () => {
    await registerForRemotePush("assistant-1");
    tap(undefined);
    tap(null);
    tap("not-an-object");
    tap({});
    tap({ deep_link: "not-an-object" });
    tap({ deep_link: { conversationId: 42 } });
    tap({ conversationId: { nested: true } });

    expect(published).toEqual([]);
    expect(captureErrorMock).not.toHaveBeenCalled();
  });
});

describe("extractPushConversationId", () => {
  test("reads data.deep_link.conversationId", () => {
    expect(
      extractPushConversationId({ deep_link: { conversationId: "conv-1" } }),
    ).toBe("conv-1");
  });

  test("falls back to a top-level conversationId", () => {
    expect(extractPushConversationId({ conversationId: "conv-2" })).toBe(
      "conv-2",
    );
  });

  test("prefers deep_link over a top-level conversationId", () => {
    expect(
      extractPushConversationId({
        deep_link: { conversationId: "conv-deep" },
        conversationId: "conv-top",
      }),
    ).toBe("conv-deep");
  });

  test("falls back to top-level when deep_link.conversationId is malformed", () => {
    expect(
      extractPushConversationId({
        deep_link: { conversationId: 42 },
        conversationId: "conv-top",
      }),
    ).toBe("conv-top");
  });

  test("returns undefined for non-object, absent, and malformed shapes", () => {
    expect(extractPushConversationId(undefined)).toBeUndefined();
    expect(extractPushConversationId(null)).toBeUndefined();
    expect(extractPushConversationId("conv-1")).toBeUndefined();
    expect(extractPushConversationId(42)).toBeUndefined();
    expect(extractPushConversationId([])).toBeUndefined();
    expect(extractPushConversationId({})).toBeUndefined();
    expect(extractPushConversationId({ deep_link: null })).toBeUndefined();
    expect(extractPushConversationId({ deep_link: {} })).toBeUndefined();
    expect(extractPushConversationId({ conversationId: 42 })).toBeUndefined();
  });
});

describe("unregisterFromRemotePush", () => {
  test("deletes the last-registered token with bundle-scoped query", async () => {
    await registerForRemotePush("assistant-1");
    registrationHandler?.({ value: "apns-token-abc" });
    await flushMicrotasks();

    await unregisterFromRemotePush();

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(lastDeleteArg).toEqual({
      path: { assistant_id: "assistant-1", token: "apns-token-abc" },
      query: { bundle_id: "ai.vocify-inc.vellum-assistant-ios" },
      throwOnError: false,
    });
  });

  test("falls back to the persisted token after a process reload (empty module memory)", async () => {
    // Simulate a prior session that persisted a registration followed by a
    // reload that wiped module memory — `lastRegistered` is null but the
    // platform still has the token, so logout must still delete it.
    localStorage.setItem(
      "vellum:push_registration",
      JSON.stringify({
        token: "persisted-token",
        bundleId: "ai.vocify-inc.vellum-assistant-ios",
        assistantId: "assistant-9",
      }),
    );

    await unregisterFromRemotePush();

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(lastDeleteArg).toEqual({
      path: { assistant_id: "assistant-9", token: "persisted-token" },
      query: { bundle_id: "ai.vocify-inc.vellum-assistant-ios" },
      throwOnError: false,
    });
  });

  test("waits for an in-flight upsert, then deletes the freshly-registered token", async () => {
    // Block the upsert so we can interleave logout while it is still in flight.
    let releaseUpsert!: () => void;
    upsertGate = new Promise<void>((resolve) => {
      releaseUpsert = resolve;
    });

    await registerForRemotePush("assistant-1");
    // iOS delivers the token; the upsert starts but hasn't resolved yet.
    registrationHandler?.({ value: "race-token" });
    await Promise.resolve();

    // User logs out mid-upsert. unregister must await the in-flight upsert
    // rather than concluding there is nothing to delete.
    const unregisterPromise = unregisterFromRemotePush();
    releaseUpsert();
    await unregisterPromise;

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(lastDeleteArg?.path.token).toBe("race-token");
  });

  test("awaits ALL concurrent in-flight upserts before deleting, not just the latest", async () => {
    let releaseUpsert!: () => void;
    upsertGate = new Promise<void>((resolve) => {
      releaseUpsert = resolve;
    });

    await registerForRemotePush("assistant-1");
    // Two overlapping upserts (e.g. manual re-upsert + cached token re-emit).
    registrationHandler?.({ value: "token-A" });
    registrationHandler?.({ value: "token-B" });
    await Promise.resolve();

    const unregisterPromise = unregisterFromRemotePush();
    releaseUpsert();
    await unregisterPromise;

    // Both upserts settled before the delete ran — no straggler can
    // re-register the token after logout.
    expect(upsertMock).toHaveBeenCalledTimes(2);
    expect(deleteMock).toHaveBeenCalledTimes(1);
  });

  test("reports a failed delete to Sentry instead of silently dropping it", async () => {
    deleteError = { detail: "server error" };
    await registerForRemotePush("assistant-1");
    registrationHandler?.({ value: "apns-token-abc" });
    await flushMicrotasks();
    captureErrorMock.mockClear();

    await unregisterFromRemotePush();

    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
  });

  test("no-ops when no token was registered", async () => {
    await unregisterFromRemotePush();
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
