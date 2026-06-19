import { beforeEach, describe, expect, mock, test } from "bun:test";

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

let registrationHandler: RegistrationHandler | null = null;
let registrationErrorHandler: ErrorHandler | null = null;
let permissionState: "granted" | "denied" | "prompt" = "granted";

const addListenerMock = mock(
  async (event: string, handler: RegistrationHandler | ErrorHandler) => {
    if (event === "registration") {
      registrationHandler = handler as RegistrationHandler;
    } else if (event === "registrationError") {
      registrationErrorHandler = handler as ErrorHandler;
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

const upsertMock = mock(async (arg: UpsertArg) => {
  lastUpsertArg = arg;
  return { data: {}, error: upsertError };
});
const deleteMock = mock(async (arg: DeleteArg) => {
  lastDeleteArg = arg;
  return { data: undefined, error: undefined };
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

beforeEach(() => {
  isNative = true;
  platform = "ios";
  permissionState = "granted";
  bundleId = "ai.vocify-inc.vellum-assistant-ios";
  registrationHandler = null;
  registrationErrorHandler = null;
  lastUpsertArg = null;
  lastDeleteArg = null;
  upsertError = undefined;
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

  test("no-ops when no token was registered", async () => {
    await unregisterFromRemotePush();
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
