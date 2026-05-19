/**
 * Tests for `initializePushNotifications` — APNs remote push registration.
 *
 * Mocks `@capacitor/core`, `@capacitor/push-notifications`, `@capacitor/app`,
 * and the generated HeyAPI mutation so the test runs without a Capacitor
 * runtime or network.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// `mock.module` in bun is process-global: a factory that returns only the
// exports this test cares about would clobber every other export for any
// test file in the same `bun test` process that imports the same module.
// Snapshot the real modules here so we can spread them in the factory and
// only override the symbols we mock.
import * as realInternalClient from "@/generated/api/sdk.gen.js";
import * as realSseConnectedStore from "@/domains/chat/lib/sse-connected-store.js";
const REAL_INTERNAL_CLIENT: Record<string, unknown> = { ...realInternalClient };
const REAL_SSE_CONNECTED_STORE: Record<string, unknown> = {
  ...realSseConnectedStore,
};

// ---------------------------------------------------------------------------
// Module mocks — must be registered before the subject module is imported.
// ---------------------------------------------------------------------------

type PermissionReceive = "granted" | "denied" | "prompt" | "prompt-with-rationale";
type PermissionResult = { receive: PermissionReceive };
type AppInfo = { name: string; id: string; build: string; version: string };
type UpsertResult = { data: undefined; response: Response };
type UpsertOptions = {
  client: unknown;
  path: { assistant_id: string };
  body: {
    token: string;
    platform: string;
    bundle_id: string;
    apns_environment: string;
  };
  throwOnError: boolean;
};

let mockPlatform: "ios" | "android" | "web" = "ios";

const mockRequestPermissions = mock(
  (): Promise<PermissionResult> => Promise.resolve({ receive: "granted" }),
);
const mockRegister = mock((): Promise<void> => Promise.resolve());
const registeredListeners: Record<string, ((payload: unknown) => void) | undefined> = {};
const mockAddListener = mock(
  (eventName: string, callback: (payload: unknown) => void) => {
    registeredListeners[eventName] = callback;
    return Promise.resolve({ remove: mock(() => Promise.resolve()) });
  },
);

const mockGetInfo = mock(
  (): Promise<AppInfo> =>
    Promise.resolve({
      name: "Vellum",
      id: "ai.vocify-inc.vellum-assistant-ios",
      build: "1",
      version: "1.0.0",
    }),
);

const mockUpsert = mock(
  (_options: UpsertOptions): Promise<UpsertResult> =>
    Promise.resolve({ data: undefined, response: new Response() }),
);

mock.module("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => mockPlatform,
    isNativePlatform: () => mockPlatform !== "web",
  },
}));

// Mirror the real Capacitor plugin proxy semantics: every property access
// (including `.then`) returns a callable wrapper. The plain-object mock that
// previously sat here was not faithful — it had no `.then` accessor, so
// `Promise.resolve(plugin)` saw `plugin.then === undefined` and the buggy
// pattern of returning the plugin from an `async` function appeared to work
// in tests while silently hanging on real iOS. This Proxy reproduces the
// `get` trap from `@capacitor/core/dist/index.cjs.js` (default branch
// returns a method wrapper) so the test suite catches that bug class.
const ALLOWED_PUSH_METHODS: Record<string, (...args: never[]) => unknown> = {
  requestPermissions: () => mockRequestPermissions(),
  register: () => mockRegister(),
  addListener: ((eventName: string, callback: (payload: unknown) => void) =>
    mockAddListener(eventName, callback)) as (...args: never[]) => unknown,
  removeListener: () => Promise.resolve(),
};
const fakePushNotifications = new Proxy(
  {},
  {
    get(_, prop) {
      if (typeof prop === "string" && prop in ALLOWED_PUSH_METHODS) {
        return ALLOWED_PUSH_METHODS[prop];
      }
      // Match Capacitor's exception format for unknown method calls. Any
      // code path that does `proxy.foo(...)` for an unknown `foo` — including
      // `.then` access triggered by Promise thenable adoption — will see a
      // rejection with this exact message shape, just like real iOS.
      return (..._args: unknown[]) =>
        Promise.reject(
          new Error(
            `"PushNotifications.${String(prop)}()" is not implemented on ios`,
          ),
        );
    },
  },
);
mock.module("@capacitor/push-notifications", () => ({
  PushNotifications: fakePushNotifications,
}));

mock.module("@capacitor/app", () => ({
  App: {
    getInfo: () => mockGetInfo(),
  },
}));

// `@/lib/vellum-api/client` is a side-effect-only module (no named
// exports consumed by the codebase), so an empty mock is safe here and
// avoids registering csrf/org-id interceptors during tests.
mock.module("@/lib/vellum-api/client.js", () => ({}));

// Spread the real heyapi barrel so other test files that share this
// process keep working. Only override `assistantsPushTokensUpsert`.
mock.module("@/clients/platform/index.js", () => ({
  ...REAL_INTERNAL_CLIENT,
  assistantsPushTokensUpsert: (options: UpsertOptions) => mockUpsert(options),
}));

mock.module("@sentry/react", () => ({
  captureException: mock(() => {}),
}));

// Spy-able SSE snapshot reader. The PR 10 `pushNotificationReceived`
// listener calls `getSSEConnectedSnapshot()` to decide whether to
// short-circuit; we want to flip the value per-test and assert that the
// snapshot is consulted.
//
// Default implementation delegates to the REAL `getSSEConnectedSnapshot`
// so cross-file tests (e.g. `sse-connected-store.test.ts`) that import
// the same module via this mock keep observing real Zustand state when
// they haven't installed a per-test override.
const realGetSSEConnectedSnapshot =
  REAL_SSE_CONNECTED_STORE.getSSEConnectedSnapshot as () => boolean;
const mockGetSSEConnectedSnapshot = mock(
  (): boolean => realGetSSEConnectedSnapshot(),
);

// Spread the real sse-connected-store so other test files
// (e.g. sse-connected-store.test.ts) keep seeing
// `useSSEConnectedStore` etc., and `getSSEConnectedSnapshot` falls
// through to the real implementation by default.
mock.module("@/domains/chat/lib/sse-connected-store", () => ({
  ...REAL_SSE_CONNECTED_STORE,
  getSSEConnectedSnapshot: () => mockGetSSEConnectedSnapshot(),
}));

// Now import the subject — module mocks above are in effect.
import {
  consumePendingPushNavigation,
  initializePushNotifications,
  setPushDeepLinkHandler,
  __resetRegisterStateForTests,
} from "@/lib/push/register.js";
import { __resetPushStateForTests, pushState } from "@/lib/push/state.js";

const ASSISTANT_ID = "asst_01H0000000000000000000";

beforeEach(() => {
  mockPlatform = "ios";
  mockRequestPermissions.mockClear();
  mockRequestPermissions.mockImplementation(() =>
    Promise.resolve({ receive: "granted" as const }),
  );
  mockRegister.mockClear();
  mockAddListener.mockClear();
  for (const key of Object.keys(registeredListeners)) {
    delete registeredListeners[key];
  }
  mockGetInfo.mockClear();
  mockGetInfo.mockImplementation(() =>
    Promise.resolve({
      name: "Vellum",
      id: "ai.vocify-inc.vellum-assistant-ios",
      build: "1",
      version: "1.0.0",
    }),
  );
  mockUpsert.mockClear();
  mockUpsert.mockImplementation(() =>
    Promise.resolve({ data: undefined, response: new Response() }),
  );
  mockGetSSEConnectedSnapshot.mockClear();
  mockGetSSEConnectedSnapshot.mockImplementation(() => false);
  __resetPushStateForTests();
  __resetRegisterStateForTests();
});

afterEach(() => {
  __resetPushStateForTests();
  __resetRegisterStateForTests();
  // Restore the default delegation to the real `getSSEConnectedSnapshot`
  // so any subsequent test file in the same `bun test` process that
  // imports `@/domains/chat/lib/sse-connected-store` observes real Zustand state
  // rather than a stale `() => false` override.
  mockGetSSEConnectedSnapshot.mockImplementation(() =>
    realGetSSEConnectedSnapshot(),
  );
});

describe("initializePushNotifications — platform gating", () => {
  test("non-iOS platform: no permission ask, no register, no POST", async () => {
    mockPlatform = "web";
    await initializePushNotifications(ASSISTANT_ID);
    expect(mockRequestPermissions).toHaveBeenCalledTimes(0);
    expect(mockRegister).toHaveBeenCalledTimes(0);
    expect(mockUpsert).toHaveBeenCalledTimes(0);
  });

  test("empty assistantId: no-op", async () => {
    await initializePushNotifications("");
    expect(mockRequestPermissions).toHaveBeenCalledTimes(0);
  });
});

describe("Capacitor plugin proxy thenable interaction", () => {
  // Regression coverage for the silent-hang bug observed in production
  // (see Sentry "PushNotifications.then() is not implemented on ios" issue).
  //
  // Capacitor plugins are JS Proxy objects whose `get` trap returns a
  // method wrapper for any property name not in a tiny allowlist
  // (`$$typeof`, `toJSON`, `addListener`, `removeListener`). That includes
  // `.then` — which means returning a Capacitor plugin from an `async`
  // function (or any other context that triggers `Promise.resolve` thenable
  // adoption) silently dispatches a `then()` method call to the native
  // platform and hangs the await. The fix is to never expose the plugin
  // through an `async` boundary; destructure it inline at the call site
  // instead. These tests guard the contract.

  test("the test mock faithfully exposes a callable .then (mirrors Capacitor)", () => {
    const thenAccessor = (fakePushNotifications as unknown as { then: unknown })
      .then;
    expect(typeof thenAccessor).toBe("function");
  });

  test("calling .then on the mocked plugin rejects with the Capacitor error message", async () => {
    const thenAccessor = (
      fakePushNotifications as unknown as {
        then: (...args: unknown[]) => Promise<unknown>;
      }
    ).then;
    let caught: unknown;
    try {
      await thenAccessor(
        () => {},
        () => {},
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      `"PushNotifications.then()" is not implemented on ios`,
    );
  });

  test("initializePushNotifications completes (does not hang) even under a Capacitor-faithful proxy mock", async () => {
    // If `register.ts` regresses to returning the plugin proxy from an
    // `async` helper, `await getPushPlugin()` will trigger thenable adoption
    // on this mock proxy — its `then()` returns a rejected promise without
    // ever calling `resolve` or `reject`, so the outer `await` would hang
    // indefinitely. We guard against that by racing the call against a short
    // timer and asserting the call wins.
    let timedOut = false;
    const timer = new Promise<"timeout">((resolve) => {
      setTimeout(() => {
        timedOut = true;
        resolve("timeout");
      }, 1000);
    });
    const result = await Promise.race([
      initializePushNotifications(ASSISTANT_ID).then(() => "done" as const),
      timer,
    ]);
    expect(timedOut).toBe(false);
    expect(result).toBe("done");
    expect(mockRequestPermissions).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });
});

describe("initializePushNotifications — happy path", () => {
  test("token registers and POSTs with correct shape (production bundle)", async () => {
    await initializePushNotifications(ASSISTANT_ID);

    // Listeners registered before register()
    expect(mockAddListener).toHaveBeenCalled();
    expect(mockRegister).toHaveBeenCalledTimes(1);

    // Simulate APNs returning a token via the registration listener.
    const onRegistration = registeredListeners["registration"];
    expect(onRegistration).toBeDefined();
    onRegistration?.({ value: "ios-device-token-abc" });

    // Allow the void-returning POST to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    const upsertCall = mockUpsert.mock.calls[0]?.[0] as UpsertOptions;
    expect(upsertCall).toBeDefined();
    expect(upsertCall.path.assistant_id).toBe(ASSISTANT_ID);
    expect(upsertCall.body.token).toBe("ios-device-token-abc");
    expect(upsertCall.body.platform).toBe("ios");
    expect(upsertCall.body.bundle_id).toBe("ai.vocify-inc.vellum-assistant-ios");
    expect(upsertCall.body.apns_environment).toBe("production");
    expect(upsertCall.throwOnError).toBe(true);

    // pushState latches updated — including the assistantId latch added
    // in PR 11 so the logout DELETE path can scope to the right row.
    expect(pushState.currentToken).toBe("ios-device-token-abc");
    expect(pushState.currentBundleId).toBe("ai.vocify-inc.vellum-assistant-ios");
    expect(pushState.currentApnsEnvironment).toBe("production");
    expect(pushState.currentAssistantId).toBe(ASSISTANT_ID);
  });

  test("staging bundle resolves to production APNs environment", async () => {
    mockGetInfo.mockImplementation(() =>
      Promise.resolve({
        name: "Vellum Staging",
        id: "ai.vocify-inc.vellum-assistant-ios.staging",
        build: "1",
        version: "1.0.0",
      }),
    );

    await initializePushNotifications(ASSISTANT_ID);
    registeredListeners["registration"]?.({ value: "staging-token" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const upsertCall = mockUpsert.mock.calls[0]?.[0] as UpsertOptions;
    expect(upsertCall.body.bundle_id).toBe(
      "ai.vocify-inc.vellum-assistant-ios.staging",
    );
    expect(upsertCall.body.apns_environment).toBe("production");
  });

  test("dev bundle resolves to development APNs environment", async () => {
    mockGetInfo.mockImplementation(() =>
      Promise.resolve({
        name: "Vellum Dev",
        id: "ai.vocify-inc.vellum-assistant-ios.dev",
        build: "1",
        version: "1.0.0",
      }),
    );

    await initializePushNotifications(ASSISTANT_ID);
    registeredListeners["registration"]?.({ value: "dev-token" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const upsertCall = mockUpsert.mock.calls[0]?.[0] as UpsertOptions;
    expect(upsertCall.body.bundle_id).toBe("ai.vocify-inc.vellum-assistant-ios.dev");
    expect(upsertCall.body.apns_environment).toBe("development");
  });
});

describe("initializePushNotifications — permission paths", () => {
  test("permission denied: no register, no POST, no throw", async () => {
    mockRequestPermissions.mockImplementation(() =>
      Promise.resolve({ receive: "denied" as const }),
    );
    await expect(initializePushNotifications(ASSISTANT_ID)).resolves.toBeUndefined();
    expect(mockRegister).toHaveBeenCalledTimes(0);
    expect(mockUpsert).toHaveBeenCalledTimes(0);
    expect(pushState.currentToken).toBeNull();
  });

  test("permission 'prompt' (provisional / undecided): no register", async () => {
    mockRequestPermissions.mockImplementation(() =>
      Promise.resolve({ receive: "prompt" as const }),
    );
    await initializePushNotifications(ASSISTANT_ID);
    expect(mockRegister).toHaveBeenCalledTimes(0);
  });
});

describe("initializePushNotifications — cold-launch capture", () => {
  test("pushNotificationActionPerformed populates pendingPushNavigation", async () => {
    await initializePushNotifications(ASSISTANT_ID);
    const onAction = registeredListeners["pushNotificationActionPerformed"];
    expect(onAction).toBeDefined();
    onAction?.({
      notification: { data: { deepLink: "/conversation/abc-123" } },
    });
    expect(pushState.pendingPushNavigation).toBe("/conversation/abc-123");
  });

  test("pushNotificationActionPerformed with no deepLink: stays null", async () => {
    await initializePushNotifications(ASSISTANT_ID);
    const onAction = registeredListeners["pushNotificationActionPerformed"];
    onAction?.({ notification: { data: {} } });
    expect(pushState.pendingPushNavigation).toBeNull();
  });

  test("pushNotificationActionPerformed with non-string deepLink: stays null", async () => {
    await initializePushNotifications(ASSISTANT_ID);
    const onAction = registeredListeners["pushNotificationActionPerformed"];
    onAction?.({ notification: { data: { deepLink: 12345 } } });
    expect(pushState.pendingPushNavigation).toBeNull();
  });
});

describe("initializePushNotifications — concurrency / idempotency", () => {
  test("concurrent calls coalesce — register() only called once", async () => {
    const p1 = initializePushNotifications(ASSISTANT_ID);
    const p2 = initializePushNotifications(ASSISTANT_ID);
    await Promise.all([p1, p2]);
    expect(mockRegister).toHaveBeenCalledTimes(1);
  });

  test("sequential calls re-register but listeners are deduped", async () => {
    await initializePushNotifications(ASSISTANT_ID);
    await initializePushNotifications(ASSISTANT_ID);
    // register() may be called twice (sequential calls don't dedupe), but
    // each Capacitor listener type was added at most once.
    const eventNames = mockAddListener.mock.calls.map((c) => c[0]);
    const counts = eventNames.reduce<Record<string, number>>((acc, name) => {
      acc[name] = (acc[name] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts["registration"]).toBe(1);
    expect(counts["registrationError"]).toBe(1);
    expect(counts["pushNotificationActionPerformed"]).toBe(1);
    expect(counts["pushNotificationReceived"]).toBe(1);
  });
});

describe("initializePushNotifications — assistant switch (stale-closure regression)", () => {
  // Codex + Devin caught this on the original PR 9 review: the `registration`
  // listener was registered once with a closure over the first call's ctx, so
  // when AssistantPageClient re-mounted with a new assistantId the registration
  // event still POSTed the token to the original assistant. The fix is to
  // store `latestCtx` at module scope and read it dynamically inside the
  // listener; these tests lock in the no-stale-closure invariant.

  test("post-switch registration POSTs to the new assistantId, not the original", async () => {
    const ASSISTANT_A = "asst_aaaaaaaaaaaaaaaaaaaaaaaa";
    const ASSISTANT_B = "asst_bbbbbbbbbbbbbbbbbbbbbbbb";

    // First mount — listener wired here, ctx={A}.
    await initializePushNotifications(ASSISTANT_A);
    registeredListeners["registration"]?.({ value: "token-call-a" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect((mockUpsert.mock.calls[0]?.[0] as UpsertOptions).path.assistant_id).toBe(
      ASSISTANT_A,
    );

    // Second mount with new assistantId — listener was already wired so it
    // is NOT re-registered, but `register()` is called again.
    await initializePushNotifications(ASSISTANT_B);
    registeredListeners["registration"]?.({ value: "token-call-b" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockUpsert).toHaveBeenCalledTimes(2);
    // CRITICAL: the second registration must POST under ASSISTANT_B, not A.
    // Before the fix, the listener closed over ctx from the first call and
    // routed the second token to ASSISTANT_A.
    expect((mockUpsert.mock.calls[1]?.[0] as UpsertOptions).path.assistant_id).toBe(
      ASSISTANT_B,
    );
  });

  test("assistant switch DURING in-flight permission ask: token POSTs under new assistant, not original", async () => {
    // Codex P1 on PR #6031: when `initializePushNotifications` is called
    // during an in-flight registration (e.g. AssistantPageClient remount
    // fires for assistant B while the permission promise for assistant A
    // is still hanging), the early-return on `registrationInFlight` must
    // not let the eventual `registration` event POST under the stale A.
    // The fix tracks `pendingAssistantId` at module scope and folds it
    // into `latestCtx` when set — both via the IIFE on first set and via
    // the early-return path's rebind for already-set `latestCtx`.
    const ASSISTANT_A = "asst_aaaaaaaaaaaaaaaaaaaaaaaa";
    const ASSISTANT_B = "asst_bbbbbbbbbbbbbbbbbbbbbbbb";

    // Block permission resolution so the IIFE awaits inside requestPermissions.
    // Definite-assignment `!:` because the resolver is captured inside the
    // mock callback and TS can't track the closure assignment back here.
    let resolvePermission!: (p: PermissionResult) => void;
    mockRequestPermissions.mockImplementationOnce(
      () =>
        new Promise<PermissionResult>((resolve) => {
          resolvePermission = resolve;
        }),
    );

    // Call A: kicks off in-flight registration; permission promise hangs.
    const firstCall = initializePushNotifications(ASSISTANT_A);
    // Yield once so the IIFE enters and parks at `await requestPermissions`.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Call B: assistant switch BEFORE permission resolves. Must not be
    // dropped — it has to update `pendingAssistantId` so the IIFE picks
    // the new assistant when it sets `latestCtx` post-permission.
    const secondCall = initializePushNotifications(ASSISTANT_B);

    // Now resolve permission. IIFE proceeds: getBundleId → set latestCtx
    // (using pendingAssistantId = B) → register listeners → register().
    resolvePermission({ receive: "granted" });
    await Promise.all([firstCall, secondCall]);

    // iOS delivers the device token via the `registration` event.
    registeredListeners["registration"]?.({ value: "device-token-xyz" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // CRITICAL: token must POST under ASSISTANT_B (the active one),
    // not ASSISTANT_A (the one that started the in-flight registration).
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect((mockUpsert.mock.calls[0]?.[0] as UpsertOptions).path.assistant_id).toBe(
      ASSISTANT_B,
    );
  });

  test("assistant switch AFTER latestCtx is set, BEFORE registration listener fires: POSTs under new assistant", async () => {
    // Tighter window: by the time call B comes in, the IIFE has already
    // set latestCtx = { A, ... } (permission and getBundleId both resolved
    // synchronously) but `register()` hasn't fired its registration event
    // yet. The early-return path's rebind on `latestCtx.assistantId` must
    // catch this so the listener — when it eventually fires — reads B.
    const ASSISTANT_A = "asst_aaaaaaaaaaaaaaaaaaaaaaaa";
    const ASSISTANT_B = "asst_bbbbbbbbbbbbbbbbbbbbbbbb";

    // Make register() block so we have a window between latestCtx-set and
    // listener-fire to slip in the second call. Definite-assignment for the
    // same reason as resolvePermission above.
    let resolveRegister!: () => void;
    mockRegister.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveRegister = resolve;
        }),
    );

    const firstCall = initializePushNotifications(ASSISTANT_A);
    // Wait for the IIFE to advance past permission + bundleId + listener
    // setup and reach `await register()`. Multiple yields cover the chain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // At this point latestCtx = { A, ... } and we're parked in register().
    // Call B comes in — must rebind latestCtx.assistantId to B in-place.
    const secondCall = initializePushNotifications(ASSISTANT_B);

    // Unblock register(); the registration event then fires.
    resolveRegister();
    await Promise.all([firstCall, secondCall]);

    registeredListeners["registration"]?.({ value: "device-token-xyz" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect((mockUpsert.mock.calls[0]?.[0] as UpsertOptions).path.assistant_id).toBe(
      ASSISTANT_B,
    );
  });

  test("post-switch context update propagates bundle/env when they change", async () => {
    // Edge case: if the bundle id ever changed between mounts (it shouldn't
    // in production, but the listener must not pin to the original bundle).
    mockGetInfo.mockImplementationOnce(() =>
      Promise.resolve({
        name: "Vellum",
        id: "ai.vocify-inc.vellum-assistant-ios",
        build: "1",
        version: "1.0.0",
      }),
    );
    await initializePushNotifications("asst_first");
    registeredListeners["registration"]?.({ value: "first-token" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    mockGetInfo.mockImplementationOnce(() =>
      Promise.resolve({
        name: "Vellum Dev",
        id: "ai.vocify-inc.vellum-assistant-ios.dev",
        build: "1",
        version: "1.0.0",
      }),
    );
    await initializePushNotifications("asst_second");
    registeredListeners["registration"]?.({ value: "second-token" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = mockUpsert.mock.calls[1]?.[0] as UpsertOptions;
    expect(second.body.bundle_id).toBe("ai.vocify-inc.vellum-assistant-ios.dev");
    expect(second.body.apns_environment).toBe("development");
  });
});

describe("initializePushNotifications — error paths", () => {
  test("upsert failure does not throw out of initialize", async () => {
    mockUpsert.mockImplementation(() => Promise.reject(new Error("500")));
    await initializePushNotifications(ASSISTANT_ID);
    registeredListeners["registration"]?.({ value: "token" });
    // Settle the rejected promise.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // No throw, no token cached.
    expect(pushState.currentToken).toBeNull();
  });

  test("registrationError listener captures without throwing", async () => {
    await initializePushNotifications(ASSISTANT_ID);
    const onErr = registeredListeners["registrationError"];
    expect(onErr).toBeDefined();
    expect(() => onErr?.({ error: "no-aps-environment" })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// PR 10 — foreground SSE-aware suppression
// ---------------------------------------------------------------------------
describe("pushNotificationReceived — SSE-aware suppression", () => {
  test("consults the SSE snapshot exactly once per push", async () => {
    await initializePushNotifications(ASSISTANT_ID);
    const onReceived = registeredListeners["pushNotificationReceived"];
    expect(onReceived).toBeDefined();
    onReceived?.({ data: { kind: "message" } });
    expect(mockGetSSEConnectedSnapshot).toHaveBeenCalledTimes(1);
  });

  test("SSE connected: handler short-circuits without throwing", async () => {
    mockGetSSEConnectedSnapshot.mockImplementation(() => true);
    await initializePushNotifications(ASSISTANT_ID);
    const onReceived = registeredListeners["pushNotificationReceived"];
    expect(() => onReceived?.({ data: { kind: "message" } })).not.toThrow();
    expect(mockGetSSEConnectedSnapshot).toHaveBeenCalledTimes(1);
  });

  test("SSE disconnected: handler runs the deferred branch without throwing", async () => {
    mockGetSSEConnectedSnapshot.mockImplementation(() => false);
    await initializePushNotifications(ASSISTANT_ID);
    const onReceived = registeredListeners["pushNotificationReceived"];
    expect(() => onReceived?.({ data: { kind: "message" } })).not.toThrow();
    expect(mockGetSSEConnectedSnapshot).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// PR 10 — live deep-link handler routing
// ---------------------------------------------------------------------------
describe("pushNotificationActionPerformed — live deep-link handler", () => {
  test("when handler registered: routes through handler and clears latch", async () => {
    const liveHandler = mock((_deepLink: string) => {});
    setPushDeepLinkHandler((deepLink) => liveHandler(deepLink));

    await initializePushNotifications(ASSISTANT_ID);
    const onAction = registeredListeners["pushNotificationActionPerformed"];
    onAction?.({ notification: { data: { deepLink: "/conversation/abc" } } });

    expect(liveHandler).toHaveBeenCalledTimes(1);
    expect(liveHandler.mock.calls[0]?.[0]).toBe("/conversation/abc");
    // Latch must be empty so the cold-launch consumer can't double-navigate.
    expect(pushState.pendingPushNavigation).toBeNull();
  });

  test("when no handler registered: stashes for cold-launch consumer", async () => {
    await initializePushNotifications(ASSISTANT_ID);
    const onAction = registeredListeners["pushNotificationActionPerformed"];
    onAction?.({ notification: { data: { deepLink: "/conversation/xyz" } } });

    expect(pushState.pendingPushNavigation).toBe("/conversation/xyz");
  });

  test("null deep link: clears latch and does not call handler", async () => {
    const liveHandler = mock((_deepLink: string) => {});
    setPushDeepLinkHandler((deepLink) => liveHandler(deepLink));

    // Pre-populate the latch to verify it gets cleared on a null payload.
    pushState.pendingPushNavigation = "/stale";

    await initializePushNotifications(ASSISTANT_ID);
    const onAction = registeredListeners["pushNotificationActionPerformed"];
    onAction?.({ notification: { data: {} } });

    expect(liveHandler).toHaveBeenCalledTimes(0);
    expect(pushState.pendingPushNavigation).toBeNull();
  });

  test("handler unregistered after registration: falls back to stash", async () => {
    const liveHandler = mock((_deepLink: string) => {});
    setPushDeepLinkHandler((deepLink) => liveHandler(deepLink));

    await initializePushNotifications(ASSISTANT_ID);

    // AssistantPageClient unmounts (e.g. cleanup runs).
    setPushDeepLinkHandler(null);

    const onAction = registeredListeners["pushNotificationActionPerformed"];
    onAction?.({ notification: { data: { deepLink: "/conversation/zzz" } } });

    expect(liveHandler).toHaveBeenCalledTimes(0);
    expect(pushState.pendingPushNavigation).toBe("/conversation/zzz");
  });
});

// ---------------------------------------------------------------------------
// PR 10 — consumePendingPushNavigation (cold-launch consumer)
// ---------------------------------------------------------------------------
describe("consumePendingPushNavigation", () => {
  test("returns the stashed deep link and clears the latch", () => {
    pushState.pendingPushNavigation = "/conversation/cold-launch";
    expect(consumePendingPushNavigation()).toBe("/conversation/cold-launch");
    expect(pushState.pendingPushNavigation).toBeNull();
  });

  test("returns null when no pending navigation", () => {
    expect(pushState.pendingPushNavigation).toBeNull();
    expect(consumePendingPushNavigation()).toBeNull();
  });

  test("second call after consumption returns null (idempotent drain)", () => {
    pushState.pendingPushNavigation = "/conversation/once";
    expect(consumePendingPushNavigation()).toBe("/conversation/once");
    expect(consumePendingPushNavigation()).toBeNull();
  });
});
