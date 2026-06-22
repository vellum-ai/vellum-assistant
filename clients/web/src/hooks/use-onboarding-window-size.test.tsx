import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// The hook reads the current route via react-router's `useLocation` and
// pushes the onboarding window mode to the Electron host. Drive both from
// mutable test doubles: flip `currentPath` between renders and capture the
// host calls.
let currentPath = "/assistant";
const setOnboardingWindowMock = mock((_active: boolean) => Promise.resolve());

mock.module("react-router", () => ({
  useLocation: () => ({ pathname: currentPath }),
}));

mock.module("@/runtime/main-window", () => ({
  setOnboardingWindow: setOnboardingWindowMock,
}));

const { useOnboardingWindowSize } = await import(
  "@/hooks/use-onboarding-window-size"
);

beforeEach(() => {
  currentPath = "/assistant";
  setOnboardingWindowMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("useOnboardingWindowSize", () => {
  test("requests the small onboarding window on an onboarding route", () => {
    currentPath = "/assistant/welcome";
    renderHook(() => useOnboardingWindowSize());
    expect(setOnboardingWindowMock).toHaveBeenLastCalledWith(true);
  });

  test("requests the full window on a non-onboarding route", () => {
    currentPath = "/assistant";
    renderHook(() => useOnboardingWindowSize());
    expect(setOnboardingWindowMock).toHaveBeenLastCalledWith(false);
  });

  test("requests the small window on the /account auth screens", () => {
    for (const path of [
      "/account",
      "/account/login",
      "/account/signup",
      "/account/provider/callback",
      "/account/password/reset",
    ]) {
      setOnboardingWindowMock.mockClear();
      currentPath = path;
      const { unmount } = renderHook(() => useOnboardingWindowSize());
      expect(setOnboardingWindowMock).toHaveBeenLastCalledWith(true);
      unmount();
    }
  });

  test("covers every onboarding step under the shared prefix", () => {
    for (const step of [
      "/assistant/welcome",
      "/assistant/select-assistant",
      "/assistant/review-terms",
      "/assistant/onboarding/hosting",
      "/assistant/onboarding/api-key",
      "/assistant/onboarding/privacy",
      "/assistant/onboarding/prechat",
      "/assistant/onboarding/hatching",
    ]) {
      setOnboardingWindowMock.mockClear();
      currentPath = step;
      const { unmount } = renderHook(() => useOnboardingWindowSize());
      expect(setOnboardingWindowMock).toHaveBeenLastCalledWith(true);
      unmount();
    }
  });

  test("re-applies when navigating from onboarding to the main app", () => {
    currentPath = "/assistant/onboarding/hatching";
    const { rerender } = renderHook(() => useOnboardingWindowSize());
    expect(setOnboardingWindowMock).toHaveBeenLastCalledWith(true);

    currentPath = "/assistant";
    rerender();
    expect(setOnboardingWindowMock).toHaveBeenLastCalledWith(false);
  });
});
