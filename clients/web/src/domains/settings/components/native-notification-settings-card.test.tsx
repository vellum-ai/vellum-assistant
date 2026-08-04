import { expect, mock, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
const openSettingsMock = mock(async () => {});
let settingsAvailable = true;
mock.module("@/runtime/platform-detection", () => ({
  useIsNativeAndroid: () => true,
}));
mock.module("@/runtime/notifications", () => ({
  getNotificationPermission: async () => "denied",
  refreshNotificationPermission: async () => "denied",
}));
mock.module("@/runtime/android-notification-settings", () => ({
  isAndroidNotificationSettingsAvailable: () => settingsAvailable,
  openAndroidNotificationSettings: openSettingsMock,
}));
const { NativeNotificationSettingsCard } =
  await import("@/domains/settings/components/native-notification-settings-card");
test("denied Android notifications link to system settings", async () => {
  const view = render(<NativeNotificationSettingsCard />);
  await view.findByText("Receive alerts when the app is closed.");
  fireEvent.click(await view.findByText("System settings"));
  expect(openSettingsMock).toHaveBeenCalledTimes(1);
});

test("hides system settings for an older Android shell", async () => {
  settingsAvailable = false;
  const view = render(<NativeNotificationSettingsCard />);
  await view.findByText("Receive alerts when the app is closed.");
  expect(view.queryByText("System settings")).toBeNull();
});
