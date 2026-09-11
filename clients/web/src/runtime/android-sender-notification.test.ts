import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  NotificationDeliveryResult,
  PrepareNotificationIdentityPayload,
} from "@vellumai/ipc-contract";

let nativePlatform = true;
let platform = "android";
let senderAvailable = true;
const getCapabilities = mock(async () => ({
  version: 1,
  capabilities: ["preparedIdentity", "singlePostOwner", "deliveryStatus"],
}));
const prepare = mock(async (_payload: PrepareNotificationIdentityPayload) => ({
  ok: true,
}));
const reset = mock(async () => ({ ok: true }));
const post = mock(
  async (_payload: unknown): Promise<NotificationDeliveryResult> => ({
    status: "posted",
  }),
);
const status = mock(async (): Promise<NotificationDeliveryResult> => ({
  status: "posted",
}));
const getOwnershipGeneration = mock(
  async (): Promise<unknown> => ({ version: 1, generation: 7 }),
);
const ownership = mock(
  async ({ active }: { active: boolean }): Promise<unknown> => ({
    version: 1,
    generation: 7,
    active,
    accepted: true,
  }),
);
const ownershipBridge = {
  getNotificationOwnershipGeneration: getOwnershipGeneration,
  setNotificationOwnership: ownership,
};

mock.module("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => nativePlatform,
    getPlatform: () => platform,
    isPluginAvailable: (name: string) =>
      name === "AndroidSenderNotification" && senderAvailable,
  },
  registerPlugin: () => ({ getCapabilities, prepare, reset, post, status }),
}));

const setNotificationIdentityNativeAdapter = mock((_adapter: unknown) => {});
mock.module("@/runtime/notification-avatar", () => ({
  setNotificationIdentityNativeAdapter,
}));

const {
  __resetAndroidSenderNotificationForTests,
  __setAndroidSenderNotificationWatchdogForTests,
  allowsLegacyAndroidNotificationFallback,
  beginAndroidNotificationOwnershipEnable,
  disableAndroidNotificationOwnership,
  enableAndroidNotificationOwnership,
  installAndroidSenderNotificationIdentityAdapter,
  postAndroidSenderNotification,
  prepareAndroidSenderNotificationIdentity,
} = await import("@/runtime/android-sender-notification");

const identity = {
  scopeId: `scope:v1:${"a".repeat(64)}`,
  assistantId: "assistant-1",
  nativeSenderId: "native-1",
};
const preparePayload: PrepareNotificationIdentityPayload = {
  identity,
  scopeEpoch: 1,
  identityRevision: 1,
  name: "Assistant",
  nameProvenance: "identity-store",
};
const postPayload = {
  correlationId: "delivery-1",
  deliveryId: "delivery-1",
  requestKey: "delivery-1",
  id: 42,
  title: "Reminder",
  body: "Ready when you are.",
  extra: { sourceEventName: "reminder.fired" },
  presentation: "assistant" as const,
  identity,
};

beforeEach(() => {
  nativePlatform = true;
  platform = "android";
  senderAvailable = true;
  getCapabilities.mockReset();
  getCapabilities.mockResolvedValue({
    version: 1,
    capabilities: ["preparedIdentity", "singlePostOwner", "deliveryStatus"],
  });
  prepare.mockClear();
  reset.mockClear();
  post.mockReset();
  post.mockResolvedValue({ status: "posted" });
  ownership.mockReset();
  ownership.mockImplementation(
    async ({ active }: { active: boolean }): Promise<unknown> => ({
      version: 1,
      generation: 7,
      active,
      accepted: true,
    }),
  );
  getOwnershipGeneration.mockReset();
  getOwnershipGeneration.mockResolvedValue({ version: 1, generation: 7 });
  setNotificationIdentityNativeAdapter.mockClear();
  __resetAndroidSenderNotificationForTests();
});

describe("Android notification ownership handshake", () => {
  test("does not request native ownership on old shells or other platforms", async () => {
    senderAvailable = false;
    expect(await enableAndroidNotificationOwnership(ownershipBridge)).toBe(false);
    platform = "ios";
    senderAvailable = true;
    __resetAndroidSenderNotificationForTests();
    expect(await enableAndroidNotificationOwnership(ownershipBridge)).toBe(false);

    expect(ownership).not.toHaveBeenCalled();
    expect(await postAndroidSenderNotification(postPayload)).toMatchObject({
      status: "unavailable",
    });
  });

  test("enables only with the complete coordinator contract", async () => {
    getCapabilities.mockResolvedValueOnce({
      version: 1,
      capabilities: ["singlePostOwner", "deliveryStatus"],
    });
    expect(await enableAndroidNotificationOwnership(ownershipBridge)).toBe(false);
    expect(ownership).not.toHaveBeenCalled();

    __resetAndroidSenderNotificationForTests();
    expect(await enableAndroidNotificationOwnership(ownershipBridge)).toBe(true);
    expect(ownership).toHaveBeenCalledWith({
      version: 1,
      generation: 7,
      active: true,
    });
    expect(await postAndroidSenderNotification(postPayload)).toEqual({
      status: "posted",
    });
  });

  test("keeps the local coordinator active when an invoked handshake is ambiguous", async () => {
    __setAndroidSenderNotificationWatchdogForTests(5);
    ownership.mockImplementationOnce(() => new Promise<never>(() => {}));

    expect(await enableAndroidNotificationOwnership(ownershipBridge)).toBe(false);
    expect(await postAndroidSenderNotification(postPayload)).toEqual({
      status: "posted",
    });
  });

  test("keeps local coordinator ownership after a malformed enable response", async () => {
    ownership.mockResolvedValueOnce({
      version: 2,
      generation: 7,
      active: false,
      accepted: false,
    });

    expect(await enableAndroidNotificationOwnership(ownershipBridge)).toBe(false);
    expect(await postAndroidSenderNotification(postPayload)).toEqual({
      status: "posted",
    });
  });

  test("clears local ownership only after native confirms disable", async () => {
    await enableAndroidNotificationOwnership(ownershipBridge);
    expect(await disableAndroidNotificationOwnership(ownershipBridge)).toBe(true);
    expect(ownership).toHaveBeenLastCalledWith({
      version: 1,
      generation: 7,
      active: false,
    });
    expect(await postAndroidSenderNotification(postPayload)).toMatchObject({
      status: "unavailable",
    });
  });

  test("retains ownership when native disable never confirms", async () => {
    await enableAndroidNotificationOwnership(ownershipBridge);
    __setAndroidSenderNotificationWatchdogForTests(5);
    ownership.mockImplementationOnce(() => new Promise<never>(() => {}));

    expect(await disableAndroidNotificationOwnership(ownershipBridge)).toBe(false);
    expect(await postAndroidSenderNotification(postPayload)).toEqual({
      status: "posted",
    });
  });

  test("accepts void and primitive bridge responses without breaking later transitions", async () => {
    ownership.mockResolvedValueOnce(undefined);
    expect(await enableAndroidNotificationOwnership(ownershipBridge)).toBe(false);
    expect(await postAndroidSenderNotification(postPayload)).toEqual({
      status: "posted",
    });

    ownership.mockResolvedValueOnce(17);
    expect(await disableAndroidNotificationOwnership(ownershipBridge)).toBe(false);
    expect(await postAndroidSenderNotification(postPayload)).toEqual({
      status: "posted",
    });

    expect(await disableAndroidNotificationOwnership(ownershipBridge)).toBe(true);
    expect(await enableAndroidNotificationOwnership(ownershipBridge)).toBe(true);
  });

  test("holds posts behind the enable transition", async () => {
    let finishGeneration!: (value: unknown) => void;
    getOwnershipGeneration.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishGeneration = resolve;
        }),
    );
    beginAndroidNotificationOwnershipEnable();
    const pendingPost = postAndroidSenderNotification(postPayload);
    const pendingEnable = enableAndroidNotificationOwnership(ownershipBridge);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(post).not.toHaveBeenCalled();

    finishGeneration({ version: 1, generation: 7 });
    expect(await pendingEnable).toBe(true);
    expect(await pendingPost).toEqual({ status: "posted" });
  });

  test("holds posts that arrive after enable starts behind the same transition", async () => {
    let finishGeneration!: (value: unknown) => void;
    getOwnershipGeneration.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishGeneration = resolve;
        }),
    );
    beginAndroidNotificationOwnershipEnable();
    const pendingEnable = enableAndroidNotificationOwnership(ownershipBridge);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pendingPost = postAndroidSenderNotification({
      ...postPayload,
      correlationId: "delivery-2",
    });
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();

    finishGeneration({ version: 1, generation: 7 });
    expect(await pendingEnable).toBe(true);
    expect(await pendingPost).toEqual({ status: "posted" });
  });
});

describe("Android sender notification bridge", () => {
  test("connects prepared identity only after capability discovery", async () => {
    installAndroidSenderNotificationIdentityAdapter();
    await prepareAndroidSenderNotificationIdentity(preparePayload);

    expect(setNotificationIdentityNativeAdapter).toHaveBeenCalledTimes(1);
    expect(getCapabilities).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(preparePayload);
  });

  test("does not post before ownership is ready", async () => {
    expect(await postAndroidSenderNotification(postPayload)).toEqual({
      status: "unavailable",
      reason: "android_notification_ownership_inactive",
    });
    expect(post).not.toHaveBeenCalled();
  });

  test("normalizes unavailable returned after post to ambiguous", async () => {
    await enableAndroidNotificationOwnership(ownershipBridge);
    post.mockResolvedValueOnce({
      status: "unavailable",
      reason: "delivery_not_found",
    });

    const result = await postAndroidSenderNotification(postPayload);

    expect(result).toEqual({
      status: "unknown",
      errorMessage: "delivery_not_found",
    });
    expect(allowsLegacyAndroidNotificationFallback(result)).toBe(false);
  });

  test("a watchdog never retries or permits a legacy duplicate", async () => {
    await enableAndroidNotificationOwnership(ownershipBridge);
    __setAndroidSenderNotificationWatchdogForTests(5);
    let finishNative!: (result: NotificationDeliveryResult) => void;
    post.mockImplementationOnce(
      () =>
        new Promise<NotificationDeliveryResult>((resolve) => {
          finishNative = resolve;
        }),
    );

    const result = await postAndroidSenderNotification(postPayload);

    expect(result).toEqual({
      status: "unknown",
      errorMessage: "android_sender_notification_watchdog_expired",
    });
    expect(post).toHaveBeenCalledTimes(1);
    expect(allowsLegacyAndroidNotificationFallback(result)).toBe(false);

    finishNative({ status: "posted" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(post).toHaveBeenCalledTimes(1);
  });
});
