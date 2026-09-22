import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

let nativeAndroid = false;
let browserHost = true;
mock.module("@/runtime/notifications", () => ({
  isBrowserNotificationHost: () => browserHost,
}));
mock.module(
  "@/domains/settings/components/browser-notification-settings-card",
  () => ({
    BrowserNotificationSettingsCard: () => <div>Browser notification controls</div>,
  }),
);

mock.module("@/runtime/platform-detection", () => ({
  useIsNativeAndroid: () => nativeAndroid,
}));

mock.module(
  "@/domains/settings/components/android-notification-settings-card",
  () => ({
    AndroidNotificationSettingsCard: () => (
      <div>Android notification controls</div>
    ),
  }),
);

const { NotificationsPage } =
  await import("@/domains/settings/pages/notifications-page");

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/assistant/settings/notifications"]}>
      <Routes>
        <Route
          path="/assistant/settings/notifications"
          element={<NotificationsPage />}
        />
        <Route
          path="/assistant/settings/general"
          element={<div>General settings</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  nativeAndroid = false;
  browserHost = true;
});

describe("NotificationsPage", () => {
  test("redirects unsupported native settings hosts to General", async () => {
    browserHost = false;
    renderPage();

    expect(await screen.findByText("General settings")).not.toBeNull();
  });

  test("shows browser notification settings", () => {
    renderPage();
    expect(screen.getByText("Browser notification controls")).not.toBeNull();
  });

  test("shows Android notification settings in the native Android app", () => {
    nativeAndroid = true;
    renderPage();

    expect(
      screen.getByRole("heading", { name: "Notifications" }),
    ).not.toBeNull();
    expect(screen.getByText("Android notification controls")).not.toBeNull();
  });
});
