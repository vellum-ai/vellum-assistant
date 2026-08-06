import { expect, mock, test } from "bun:test";

let isAndroid = false;
let isAvailable = true;
const ensureAlertsChannelMock = mock(async () => {});
const createChannelMock = mock(async () => {});

mock.module("@/runtime/platform-detection", () => ({
  isNativeAndroid: () => isAndroid,
}));

mock.module("@capacitor/core", () => ({
  Capacitor: {
    isPluginAvailable: () => isAvailable,
  },
  registerPlugin: () => ({
    ensureAlertsChannel: ensureAlertsChannelMock,
  }),
}));

mock.module("@capacitor/local-notifications", () => ({
  LocalNotifications: {
    createChannel: createChannelMock,
  },
}));

const { ensureAndroidAlertsChannel } =
  await import("./android-notification-channels");

test("creates the Android channel across native shell versions", async () => {
  await ensureAndroidAlertsChannel();
  expect(ensureAlertsChannelMock).not.toHaveBeenCalled();
  expect(createChannelMock).not.toHaveBeenCalled();

  isAndroid = true;
  isAvailable = false;
  createChannelMock.mockRejectedValueOnce(new Error("unavailable"));
  await expect(ensureAndroidAlertsChannel()).rejects.toThrow("unavailable");
  expect(createChannelMock).toHaveBeenCalledTimes(1);

  isAvailable = true;
  await ensureAndroidAlertsChannel();
  await ensureAndroidAlertsChannel();

  expect(ensureAlertsChannelMock).toHaveBeenCalledTimes(1);
});
