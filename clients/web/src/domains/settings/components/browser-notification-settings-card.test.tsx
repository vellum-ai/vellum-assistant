import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

let permission: "prompt" | "denied" | "granted" | "unsupported" = "prompt";
const request = mock(async () => permission);
mock.module("@/runtime/notifications", () => ({
  refreshNotificationPermission: async () => permission,
  requestBrowserNotificationPermission: request,
}));
const { BrowserNotificationSettingsCard } = await import(
  "@/domains/settings/components/browser-notification-settings-card"
);

afterEach(() => {
  cleanup();
  permission = "prompt";
  request.mockClear();
});

test("permission is requested only from Enable and an unanswered prompt can be retried", async () => {
  const view = render(<BrowserNotificationSettingsCard />);
  const button = await view.findByRole("button", { name: "Enable notifications" });
  expect(request).not.toHaveBeenCalled();
  await act(async () => { fireEvent.click(button); });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  await act(async () => { fireEvent.click(button); });
  expect(request).toHaveBeenCalledTimes(2);
});

test("denied permission shows browser settings guidance without another prompt", async () => {
  permission = "denied";
  const view = render(<BrowserNotificationSettingsCard />);
  await view.findByText("Notifications are blocked. Allow notifications for this site in your browser settings.");
  expect(view.queryByRole("button")).toBeNull();
  expect(request).not.toHaveBeenCalled();
});

test("unsupported browsers explain the limitation", async () => {
  permission = "unsupported";
  const view = render(<BrowserNotificationSettingsCard />);
  await view.findByText("This browser does not support system notifications.");
  expect(view.queryByRole("button")).toBeNull();
});
