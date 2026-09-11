import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { VELLUM_DOWNLOADS_URL } from "@/utils/external-urls";

const emitNudgeEvent = mock(
  (_action: string, _surface: string, _target: string) => {},
);

mock.module("@/utils/native-app-nudge-telemetry", () => ({
  emitNativeAppNudgeEvent: emitNudgeEvent,
}));

const { openDesktopAppDownload, useDesktopAppNudgeState } = await import(
  "@/hooks/use-desktop-app-nudge"
);

const originalWindowOpen = window.open;

beforeEach(() => {
  localStorage.clear();
  emitNudgeEvent.mockClear();
});

afterEach(() => {
  cleanup();
  window.open = originalWindowOpen;
});

describe("desktop app download link", () => {
  test("opens the canonical downloads page", () => {
    const open = mock(() => null);
    window.open = open as typeof window.open;

    openDesktopAppDownload();

    expect(open).toHaveBeenCalledWith(
      "https://www.vellum.ai/downloads",
      "_blank",
      "noopener,noreferrer",
    );
    expect(VELLUM_DOWNLOADS_URL).toBe("https://www.vellum.ai/downloads");
  });

  test("tags Windows clicks and dismissals with the Windows target", () => {
    window.open = mock(() => null) as typeof window.open;
    const { result } = renderHook(() =>
      useDesktopAppNudgeState("windows"),
    );

    act(() => result.current.handleDownload());
    act(() => result.current.handleBannerDismiss());

    expect(emitNudgeEvent.mock.calls).toEqual([
      ["click", "banner", "windows"],
      ["dismiss", "banner", "windows"],
    ]);
  });
});
