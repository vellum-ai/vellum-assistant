import { expect, mock, test } from "bun:test";

import { fireEvent, render, waitFor } from "@testing-library/react";

const openSettingsMock = mock(async () => true);

mock.module("@/runtime/platform-detection", () => ({
  useIsNativeAndroid: () => true,
}));
mock.module("@/hooks/use-bus-subscription", () => ({
  useBusSubscription: () => {},
}));
mock.module("@/runtime/notifications", () => ({
  getNotificationPermission: async () => "denied",
  refreshNotificationPermission: async () => "denied",
}));
mock.module("@/runtime/android-notification-settings", () => ({
  openAndroidNotificationSettings: openSettingsMock,
}));

const { NativeNotificationSettingsCard } =
  await import("@/domains/settings/components/native-notification-settings-card");

test("opens Android notification settings", async () => {
  const view = render(<NativeNotificationSettingsCard />);
  await waitFor(() => view.getByText("System settings"));

  fireEvent.click(view.getByText("System settings"));

  await waitFor(() => expect(openSettingsMock).toHaveBeenCalledTimes(1));
});
