import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let nativeMobile = false;
let iosWeb = false;
let iosSafariWeb = false;
let androidWeb = false;

mock.module("@/utils/native-app-nudge-telemetry", () => ({
  emitNativeAppNudgeEvent: () => {},
  emitNativeAppNudgeImpressionOnce: () => {},
}));

mock.module("@/runtime/platform-detection", () => ({
  useIsNativeMobile: () => nativeMobile,
  useIsIOSWeb: () => iosWeb,
  useIsIOSSafariWeb: () => iosSafariWeb,
  useIsAndroidWeb: () => androidWeb,
}));

const { NativeAppReminderNudge } = await import("./native-app-reminder-nudge");
const { ANDROID_PLAY_STORE_URL, IOS_APP_STORE_URL } = await import(
  "@/hooks/use-native-app-nudge"
);
const env = import.meta.env as Record<string, string | undefined>;
const originalPlayStoreUrl = env.VITE_ANDROID_PLAY_STORE_URL;
const originalWindowOpen = window.open;

beforeEach(() => {
  localStorage.clear();
  nativeMobile = iosWeb = iosSafariWeb = androidWeb = false;
  env.VITE_ANDROID_PLAY_STORE_URL = ANDROID_PLAY_STORE_URL;
});

afterEach(() => {
  cleanup();
  window.open = originalWindowOpen;
  if (originalPlayStoreUrl === undefined) {
    delete env.VITE_ANDROID_PLAY_STORE_URL;
  } else {
    env.VITE_ANDROID_PLAY_STORE_URL = originalPlayStoreUrl;
  }
});

test.each(["schedule-created", "notifications-empty"] as const)(
  "%s offers both phone stores on desktop without waiting for chat turns",
  (surface) => {
    render(<NativeAppReminderNudge surface={surface} />);

    expect(
      screen.getByText("Get schedule reminders on your phone."),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Download iOS app" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Download Android app" }),
    ).toBeDefined();
  },
);

test.each(["ios", "android"] as const)(
  "opens the %s listing and hides both mounted surfaces",
  (platform) => {
    const open = mock(() => null);
    window.open = open as typeof window.open;
    render(
      <>
        <NativeAppReminderNudge surface="schedule-created" />
        <NativeAppReminderNudge surface="notifications-empty" />
      </>,
    );

    fireEvent.click(
      screen.getAllByRole("button", {
        name: platform === "ios" ? "Download iOS app" : "Download Android app",
      })[0]!,
    );

    expect(open).toHaveBeenCalledWith(
      platform === "ios" ? IOS_APP_STORE_URL : ANDROID_PLAY_STORE_URL,
      "_blank",
      "noopener,noreferrer",
    );
    expect(screen.queryByRole("status")).toBeNull();
  },
);

test("dismissal persists across placements", () => {
  const schedule = render(
    <NativeAppReminderNudge surface="schedule-created" />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  schedule.unmount();
  render(<NativeAppReminderNudge surface="notifications-empty" />);
  expect(screen.queryByRole("status")).toBeNull();
});

test("suppresses the offer when a native download is already recorded", () => {
  localStorage.setItem("app.androidNudge.downloaded", "true");
  render(<NativeAppReminderNudge surface="schedule-created" />);
  expect(screen.queryByRole("status")).toBeNull();
});

test("suppresses the offer inside native mobile apps", () => {
  nativeMobile = true;
  render(<NativeAppReminderNudge surface="notifications-empty" />);
  expect(screen.queryByRole("status")).toBeNull();
});

test.each(["ios", "safari", "android"])(
  "offers only the matching store in %s browsers",
  (platform) => {
    iosWeb = platform === "ios";
    iosSafariWeb = platform === "safari";
    androidWeb = platform === "android";
    render(<NativeAppReminderNudge surface="notifications-empty" />);
    expect(
      screen.getByRole("button", {
        name: androidWeb ? "Download Android app" : "Download iOS app",
      }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", {
        name: androidWeb ? "Download iOS app" : "Download Android app",
      }),
    ).toBeNull();
  },
);

test("keeps the downloads fallback when the Play listing is unavailable", () => {
  delete env.VITE_ANDROID_PLAY_STORE_URL;
  androidWeb = true;
  const open = mock(() => null);
  window.open = open as typeof window.open;
  render(<NativeAppReminderNudge surface="notifications-empty" />);
  fireEvent.click(
    screen.getByRole("button", { name: "Download Vellum mobile app" }),
  );
  expect(open).toHaveBeenCalledWith(
    "https://www.vellum.ai/downloads",
    "_blank",
    "noopener,noreferrer",
  );
});
