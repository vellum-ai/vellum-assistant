import { expect, mock, test } from "bun:test";

let isAndroid = false;
let isAvailable = true;
const ensureAlertsChannelMock = mock(async () => {});

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

const { ensureAndroidAlertsChannel } =
  await import("./android-notification-channels");

test("uses the guarded native channel plugin when available", async () => {
  await ensureAndroidAlertsChannel();
  expect(ensureAlertsChannelMock).not.toHaveBeenCalled();

  isAndroid = true;
  isAvailable = false;
  await ensureAndroidAlertsChannel();
  expect(ensureAlertsChannelMock).not.toHaveBeenCalled();

  isAvailable = true;
  ensureAlertsChannelMock.mockRejectedValueOnce(new Error("unavailable"));
  await expect(ensureAndroidAlertsChannel()).rejects.toThrow("unavailable");
  await ensureAndroidAlertsChannel();
  await ensureAndroidAlertsChannel();

  expect(ensureAlertsChannelMock).toHaveBeenCalledTimes(2);
});
