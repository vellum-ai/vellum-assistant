import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  NotificationDeliveryResult,
  PrepareNotificationIdentityPayload,
  ResetNotificationIdentitiesPayload,
} from "@vellumai/ipc-contract";

let nativePlatform = true;
let platform = "ios";
let pluginAvailable = true;

const getCapabilities = mock(async () => ({
  version: 1,
  capabilities: [
    "preparedIdentity",
    "singlePostOwner",
    "deliveryStatus",
  ],
}));
const prepare = mock(async (_payload: PrepareNotificationIdentityPayload) => ({
  ok: true,
}));
const reset = mock(async (_payload: ResetNotificationIdentitiesPayload) => ({
  ok: true,
}));
const post = mock(async (_payload: unknown): Promise<NotificationDeliveryResult> => ({
  status: "posted",
}));
const status = mock(async (): Promise<NotificationDeliveryResult> => ({
  status: "posted",
}));

mock.module("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => nativePlatform,
    getPlatform: () => platform,
    isPluginAvailable: () => pluginAvailable,
  },
  registerPlugin: () => ({ getCapabilities, prepare, reset, post, status }),
}));

const setNotificationIdentityNativeAdapter = mock((_adapter: unknown) => {});
mock.module("@/runtime/notification-avatar", () => ({
  setNotificationIdentityNativeAdapter,
}));

const {
  __resetSenderNotificationForTests,
  __setSenderNotificationWatchdogForTests,
  allowsLegacyNotificationFallback,
  installSenderNotificationIdentityAdapter,
  postSenderNotification,
  prepareSenderNotificationIdentity,
  resetSenderNotificationIdentities,
} = await import("@/runtime/sender-notification");

const identity = {
  scopeId: `scope:v1:${"a".repeat(64)}`,
  assistantId: "assistant-1",
  nativeSenderId: "native-1",
};

const preparePayload: PrepareNotificationIdentityPayload = {
  identity,
  scopeEpoch: 1,
  identityRevision: 2,
  name: "Assistant",
  nameProvenance: "identity-store",
};

const resetPayload: ResetNotificationIdentitiesPayload = {
  scopeId: identity.scopeId,
  scopeEpoch: 2,
};

const postPayload = {
  deliveryId: "delivery-1",
  requestKey: "delivery-1",
  id: 42,
  title: "Reminder",
  body: "Stand up",
  extra: { sourceEventName: "reminder.fired" },
  presentation: "assistant" as const,
  identity,
  name: "Assistant",
  nameProvenance: "identity-store" as const,
};

beforeEach(() => {
  nativePlatform = true;
  platform = "ios";
  pluginAvailable = true;
  getCapabilities.mockReset();
  getCapabilities.mockResolvedValue({
    version: 1,
    capabilities: [
      "preparedIdentity",
      "singlePostOwner",
      "deliveryStatus",
    ],
  });
  prepare.mockClear();
  reset.mockClear();
  post.mockReset();
  post.mockResolvedValue({ status: "posted" });
  status.mockClear();
  setNotificationIdentityNativeAdapter.mockClear();
  __resetSenderNotificationForTests();
});

describe("sender notification bridge gating", () => {
  test("makes no bridge request outside native iOS", async () => {
    nativePlatform = false;

    expect(await postSenderNotification(postPayload)).toEqual({
      status: "unavailable",
      reason: "sender_notification_unavailable",
    });
    await prepareSenderNotificationIdentity(preparePayload);
    await resetSenderNotificationIdentities(resetPayload);
    installSenderNotificationIdentityAdapter();

    expect(getCapabilities).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(setNotificationIdentityNativeAdapter).not.toHaveBeenCalled();
  });

  test("makes no bridge request when an older shell has no plugin", async () => {
    pluginAvailable = false;

    expect(await postSenderNotification(postPayload)).toMatchObject({
      status: "unavailable",
    });
    expect(getCapabilities).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  test("checks capabilities before preparing, resetting, or posting", async () => {
    await prepareSenderNotificationIdentity(preparePayload);
    await resetSenderNotificationIdentities(resetPayload);
    const result = await postSenderNotification(postPayload);

    expect(result).toEqual({ status: "posted" });
    expect(getCapabilities).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(preparePayload);
    expect(reset).toHaveBeenCalledWith(resetPayload);
    expect(post).toHaveBeenCalledWith(postPayload);
  });

  test("does not call methods omitted by the installed contract", async () => {
    getCapabilities.mockResolvedValue({
      version: 1,
      capabilities: ["deliveryStatus"],
    });

    await prepareSenderNotificationIdentity(preparePayload);
    await resetSenderNotificationIdentities(resetPayload);
    const result = await postSenderNotification(postPayload);

    expect(prepare).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(result.status).toBe("unavailable");
  });

  test("installs the process-memory adapter only for a registered iOS plugin", () => {
    installSenderNotificationIdentityAdapter();

    expect(setNotificationIdentityNativeAdapter).toHaveBeenCalledTimes(1);
    expect(setNotificationIdentityNativeAdapter.mock.calls[0]?.[0]).toEqual({
      registerIdentityPublisher: expect.any(Function),
      prepareIdentity: prepareSenderNotificationIdentity,
      resetIdentities: resetSenderNotificationIdentities,
    });
  });

  test("registers the renderer session through capability discovery", async () => {
    getCapabilities.mockResolvedValue({
      version: 1,
      capabilities: [
        "preparedIdentity",
        "identityPublisherSessions",
        "singlePostOwner",
        "deliveryStatus",
      ],
    });
    installSenderNotificationIdentityAdapter();
    const adapter = setNotificationIdentityNativeAdapter.mock.calls[0]?.[0] as {
      registerIdentityPublisher(sessionId: string): Promise<boolean>;
    };

    expect(await adapter.registerIdentityPublisher("session-a")).toBe(true);
    expect(getCapabilities).toHaveBeenCalledWith({
      publisherSessionId: "session-a",
    });
  });
});

describe("sender notification delivery ownership", () => {
  test("normalizes native delivery statuses without reopening ownership", async () => {
    const cases: Array<{
      native: NotificationDeliveryResult;
      expected: NotificationDeliveryResult;
    }> = [
      { native: { status: "posted" }, expected: { status: "posted" } },
      { native: { status: "duplicate" }, expected: { status: "duplicate" } },
      {
        native: { status: "blocked", reason: "authorization_denied" },
        expected: { status: "blocked", reason: "authorization_denied" },
      },
      {
        native: {
          status: "failed",
          postingMayHaveBegun: false,
          errorMessage: "request_rejected",
        },
        expected: {
          status: "failed",
          postingMayHaveBegun: false,
          errorMessage: "request_rejected",
        },
      },
      {
        native: { status: "unknown", errorMessage: "delivery_in_flight" },
        expected: { status: "unknown", errorMessage: "delivery_in_flight" },
      },
      {
        native: { status: "unavailable", reason: "delivery_not_found" },
        expected: { status: "unknown", errorMessage: "delivery_not_found" },
      },
    ];

    for (const testCase of cases) {
      post.mockResolvedValueOnce(testCase.native);
      const result = await postSenderNotification(postPayload);
      expect(result).toEqual(testCase.expected);
      if (testCase.native.status === "unavailable") {
        expect(allowsLegacyNotificationFallback(result)).toBe(false);
      }
    }
    expect(post).toHaveBeenCalledTimes(cases.length);
  });

  test("allows fallback only after explicit no-ownership confirmation", () => {
    expect(
      allowsLegacyNotificationFallback({ status: "unavailable" }),
    ).toBe(true);
    expect(
      allowsLegacyNotificationFallback({
        status: "failed",
        postingMayHaveBegun: false,
      }),
    ).toBe(true);
    expect(
      allowsLegacyNotificationFallback({
        status: "failed",
        postingMayHaveBegun: true,
      }),
    ).toBe(false);
    expect(allowsLegacyNotificationFallback({ status: "unknown" })).toBe(
      false,
    );
    expect(allowsLegacyNotificationFallback({ status: "blocked" })).toBe(
      false,
    );
  });

  test("returns unknown without reposting when the native bridge never resolves", async () => {
    __setSenderNotificationWatchdogForTests(5);
    let resolveNative!: (result: NotificationDeliveryResult) => void;
    post.mockImplementationOnce(
      () =>
        new Promise<NotificationDeliveryResult>((resolve) => {
          resolveNative = resolve;
        }),
    );

    const result = await postSenderNotification(postPayload);

    expect(result).toEqual({
      status: "unknown",
      errorMessage: "sender_notification_watchdog_expired",
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(allowsLegacyNotificationFallback(result)).toBe(false);

    resolveNative({ status: "posted" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(post).toHaveBeenCalledTimes(1);
  });

  test("treats a rejected or malformed post response as ambiguous", async () => {
    post.mockRejectedValueOnce(new Error("bridge disconnected"));
    const rejected = await postSenderNotification(postPayload);
    post.mockResolvedValueOnce({ unexpected: true } as never);
    const malformed = await postSenderNotification(postPayload);

    expect(rejected.status).toBe("unknown");
    expect(malformed).toEqual({
      status: "unknown",
      errorMessage: "invalid_sender_notification_result",
    });
    expect(allowsLegacyNotificationFallback(rejected)).toBe(false);
    expect(allowsLegacyNotificationFallback(malformed)).toBe(false);
  });

  test("falls back before ownership when capability discovery never resolves", async () => {
    __setSenderNotificationWatchdogForTests(5);
    getCapabilities.mockImplementationOnce(
      () => new Promise<never>(() => {}),
    );

    const result = await postSenderNotification(postPayload);

    expect(result.status).toBe("unavailable");
    expect(post).not.toHaveBeenCalled();
    expect(allowsLegacyNotificationFallback(result)).toBe(true);
  });
});
