import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import {
  ANDROID_PLAY_STORE_URL,
  getNativeAppPromotion,
  incrementNativeAppAssistantTurnsSeen,
  openNativeAppStore,
  readNativeAppAssistantTurnsSeen,
  useNativeAppNudgeState,
} from "@/hooks/use-native-app-nudge";

const env = import.meta.env as Record<string, string | undefined>;
const originalPlayStoreUrl = env.VITE_ANDROID_PLAY_STORE_URL;
const originalWindowOpen = window.open;

beforeEach(() => {
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

describe("Android promotion readiness", () => {
  test("stays unavailable until the expected Play listing is configured", () => {
    expect(getNativeAppPromotion("android")).toBeNull();

    env.VITE_ANDROID_PLAY_STORE_URL =
      "https://example.com/store/apps/details?id=ai.vellum.assistant";
    expect(getNativeAppPromotion("android")).toBeNull();

    env.VITE_ANDROID_PLAY_STORE_URL =
      "https://play.google.com/store/apps/details?id=ai.vellum.assistant&hl=en";
    expect(getNativeAppPromotion("android")).toEqual({
      platform: "android",
      appName: "Android",
      storeUrl: ANDROID_PLAY_STORE_URL,
    });
  });

  test("tags the listing with an install referrer", () => {
    const url = new URL(ANDROID_PLAY_STORE_URL);

    expect([...url.searchParams.keys()]).toEqual(["id", "referrer"]);
    expect(url.searchParams.get("id")).toBe("ai.vellum.assistant");
    expect(url.searchParams.get("referrer")).toBe(
      "utm_source=vellum-app&utm_medium=in-app-nudge",
    );
  });

  test("does not record a download when promotion is unavailable", () => {
    const open = mock(() => null);
    window.open = open as typeof window.open;

    expect(openNativeAppStore("android")).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(localStorage.getItem("app.androidNudge.downloaded")).toBeNull();
  });
});

describe("native app nudge state", () => {
  test("reads the existing iOS dismissal key", () => {
    localStorage.setItem("app.iosNudge.bannerDismissed", "true");

    const { result } = renderHook(() => useNativeAppNudgeState("ios"));

    expect(result.current.bannerShouldShow).toBe(false);
  });

  test("keeps iOS download state on the existing key", () => {
    const open = mock(() => null);
    window.open = open as typeof window.open;
    const { result } = renderHook(() => useNativeAppNudgeState("ios"));

    act(() => result.current.handleDownload());

    expect(open).toHaveBeenCalledWith(
      "https://apps.apple.com/us/app/vellum-assistant/id6759934423",
      "_blank",
      "noopener,noreferrer",
    );
    expect(localStorage.getItem("app.iosNudge.downloaded")).toBe("true");
    expect(result.current.bannerShouldShow).toBe(false);
  });

  test("keeps Android state separate from iOS", () => {
    env.VITE_ANDROID_PLAY_STORE_URL =
      "https://play.google.com/store/apps/details?id=ai.vellum.assistant";
    const { result } = renderHook(() => useNativeAppNudgeState("android"));

    act(() => result.current.handleBannerDismiss());
    incrementNativeAppAssistantTurnsSeen("android", 3);

    expect(localStorage.getItem("app.androidNudge.bannerDismissed")).toBe(
      "true",
    );
    expect(localStorage.getItem("app.iosNudge.bannerDismissed")).toBeNull();
    expect(readNativeAppAssistantTurnsSeen("android")).toBe(3);
    expect(localStorage.getItem("app.iosNudge.assistantTurnsSeen")).toBeNull();
  });
});
