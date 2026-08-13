/**
 * The flags that hold the mobile composer's pills row up while one of its
 * settings sheets has focus, and the breakpoint swap that has to clear them.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useComposerSettingsSheets } from "./use-composer-settings-sheets";

afterEach(() => {
  cleanup();
});

describe("useComposerSettingsSheets", () => {
  test("starts closed and reports either sheet as open", () => {
    const { result } = renderHook(() => useComposerSettingsSheets(true));
    expect(result.current.settingsSheetOpen).toBe(false);

    act(() => result.current.onAccessOpenChange(true));
    expect(result.current.settingsSheetOpen).toBe(true);

    act(() => result.current.onAccessOpenChange(false));
    act(() => result.current.onProfileOpenChange(true));
    expect(result.current.settingsSheetOpen).toBe(true);
  });

  test("crossing the breakpoint clears an open sheet's flag", () => {
    // GIVEN a phone with the access sheet open above the composer
    const { result, rerender } = renderHook(
      ({ isMobile }: { isMobile: boolean }) =>
        useComposerSettingsSheets(isMobile),
      { initialProps: { isMobile: true } },
    );
    act(() => result.current.onAccessOpenChange(true));
    expect(result.current.settingsSheetOpen).toBe(true);

    // WHEN it rotates into the desktop presentation, which unmounts the menu
    // that owned the sheet without a close of its own
    rerender({ isMobile: false });

    // THEN the flag goes with the instance that set it
    expect(result.current.settingsSheetOpen).toBe(false);

    // AND rotating back leaves the row nothing to hold up
    rerender({ isMobile: true });
    expect(result.current.settingsSheetOpen).toBe(false);
  });

  test("clears the profile flag on the same swap", () => {
    const { result, rerender } = renderHook(
      ({ isMobile }: { isMobile: boolean }) =>
        useComposerSettingsSheets(isMobile),
      { initialProps: { isMobile: true } },
    );
    act(() => result.current.onProfileOpenChange(true));

    rerender({ isMobile: false });

    expect(result.current.settingsSheetOpen).toBe(false);
  });

  test("a re-render at the same presentation leaves an open sheet alone", () => {
    const { result, rerender } = renderHook(
      ({ isMobile }: { isMobile: boolean }) =>
        useComposerSettingsSheets(isMobile),
      { initialProps: { isMobile: true } },
    );
    act(() => result.current.onAccessOpenChange(true));

    rerender({ isMobile: true });

    expect(result.current.settingsSheetOpen).toBe(true);
  });
});
