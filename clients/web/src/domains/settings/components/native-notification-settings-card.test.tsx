import { beforeEach, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

let permission: "granted" | "denied" | "prompt" | "unsupported" = "denied";
let resumeHandler: (() => void) | null = null;
const openSettingsMock = mock(async () => true);

mock.module("@/runtime/platform-detection", () => ({
  useIsNativeAndroid: () => true,
}));
mock.module("@/hooks/use-bus-subscription", () => ({
  useBusSubscription: (_event: string, handler: () => void) => {
    resumeHandler = handler;
  },
}));
mock.module("@/runtime/notifications", () => ({
  getNotificationPermission: async () => permission,
  refreshNotificationPermission: async () => permission,
}));
mock.module("@/runtime/android-notification-settings", () => ({
  openAndroidNotificationSettings: openSettingsMock,
}));

const { NativeNotificationSettingsCard } =
  await import("@/domains/settings/components/native-notification-settings-card");

beforeEach(() => {
  cleanup();
  permission = "denied";
  resumeHandler = null;
  openSettingsMock.mockReset();
  openSettingsMock.mockResolvedValue(true);
});

test("denial recovery reports a missing native settings plugin", async () => {
  openSettingsMock.mockResolvedValue(false);
  const view = render(<NativeNotificationSettingsCard />);
  await waitFor(() => view.getByText("System settings"));

  fireEvent.click(view.getByText("System settings"));

  await waitFor(() => expect(openSettingsMock).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    view.getByText("Could not open Android notification settings."),
  );

  permission = "granted";
  resumeHandler?.();
  await waitFor(() => view.getByText("Enabled for this device."));
});
