import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

const openSettingsMock = mock(async () => {});
let permission: "denied" | "granted" = "denied";
let settingsAvailable = true;

mock.module("@/runtime/notifications", () => ({
  getNotificationPermission: async () => permission,
  refreshNotificationPermission: async () => permission,
}));

mock.module("@/runtime/android-notification-settings", () => ({
  isAndroidNotificationSettingsAvailable: () => settingsAvailable,
  openAndroidNotificationSettings: openSettingsMock,
}));

const { AndroidNotificationSettingsCard } =
  await import("@/domains/settings/components/android-notification-settings-card");

afterEach(() => {
  cleanup();
  openSettingsMock.mockClear();
  permission = "denied";
  settingsAvailable = true;
});

test("links disabled Android notifications to settings", async () => {
  const view = render(<AndroidNotificationSettingsCard />);

  await view.findByText("Notifications are turned off in Android settings.");
  fireEvent.click(view.getByRole("button", { name: "Open settings" }));

  expect(openSettingsMock).toHaveBeenCalledTimes(1);
});

test("shows when push notifications are enabled", async () => {
  permission = "granted";
  const view = render(<AndroidNotificationSettingsCard />);

  expect(await view.findByText("Push notifications")).not.toBeNull();
  expect(view.getByText("On")).not.toBeNull();
  expect(
    view.getByText("Notifications are allowed on this device."),
  ).not.toBeNull();
});

test("hides settings for an older Android shell", async () => {
  settingsAvailable = false;
  const view = render(<AndroidNotificationSettingsCard />);

  await view.findByText("Notifications are turned off in Android settings.");
  expect(view.queryByRole("button", { name: "Open settings" })).toBeNull();
});
