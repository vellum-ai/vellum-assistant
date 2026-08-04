import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let iosWeb = false;
let androidWeb = false;

mock.module("@/runtime/platform-detection", () => ({
  useIsIOSWeb: () => iosWeb,
  useIsAndroidWeb: () => androidWeb,
}));

const { NativeAppCard } = await import(
  "@/domains/settings/components/native-app-card"
);

const env = import.meta.env as Record<string, string | undefined>;
const originalPlayStoreUrl = env.VITE_ANDROID_PLAY_STORE_URL;
const originalWindowOpen = window.open;

beforeEach(() => {
  iosWeb = false;
  androidWeb = false;
  localStorage.clear();
  delete env.VITE_ANDROID_PLAY_STORE_URL;
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

describe("NativeAppCard", () => {
  test("preserves the iOS settings promotion", () => {
    iosWeb = true;

    render(<NativeAppCard />);

    expect(screen.getByText("Get the iOS App")).toBeDefined();
    expect(
      screen.getByText("The Vellum iOS app gives you a native experience."),
    ).toBeDefined();
  });

  test("hides Android promotion without a configured Play listing", () => {
    androidWeb = true;

    const { container } = render(<NativeAppCard />);

    expect(container.innerHTML).toBe("");
  });

  test("opens a configured Android listing and records the action", () => {
    androidWeb = true;
    env.VITE_ANDROID_PLAY_STORE_URL =
      "https://play.google.com/store/apps/details?id=ai.vellum.assistant";
    const open = mock(() => null);
    window.open = open as typeof window.open;
    render(<NativeAppCard />);

    fireEvent.click(screen.getByRole("button", { name: "Download" }));

    expect(open).toHaveBeenCalledWith(
      "https://play.google.com/store/apps/details?id=ai.vellum.assistant",
      "_blank",
      "noopener,noreferrer",
    );
    expect(localStorage.getItem("app.androidNudge.downloaded")).toBe("true");
    expect(localStorage.getItem("app.iosNudge.downloaded")).toBeNull();
  });
});
