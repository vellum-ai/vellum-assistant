import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import {
  useLinuxNudgeState,
  KEY_LINUX_APP_FIRST_SEEN_AT,
  LINUX_APP_BANNER_MIN_AGE_MS,
  readLinuxAppDownloaded,
} from "@/hooks/use-linux-app-nudge";
import {
  useMacOsNudgeState,
  readMacOsAppDownloaded,
} from "@/hooks/use-macos-app-nudge";
import { setLocalNumber } from "@/utils/local-settings";
import { VELLUM_DOWNLOADS_URL } from "@/utils/external-urls";

import * as telemetry from "@/utils/native-app-nudge-telemetry";

const emitEvent = spyOn(
  telemetry,
  "emitNativeAppNudgeEvent",
).mockImplementation(() => {});
const originalOpen = window.open;
beforeEach(() => {
  localStorage.clear();
  emitEvent.mockClear();
});
afterEach(() => {
  cleanup();
  window.open = originalOpen;
});

test("Linux age gate starts only when eligible and respects a later disable", () => {
  const { result, rerender } = renderHook(
    ({ eligible }) => useLinuxNudgeState(eligible),
    { initialProps: { eligible: false } },
  );
  expect(localStorage.getItem(KEY_LINUX_APP_FIRST_SEEN_AT)).toBeNull();
  expect(result.current.ageEligible).toBe(false);
  rerender({ eligible: true });
  expect(localStorage.getItem(KEY_LINUX_APP_FIRST_SEEN_AT)).not.toBeNull();
  expect(result.current.ageEligible).toBe(false);
  rerender({ eligible: false });
  setLocalNumber(
    KEY_LINUX_APP_FIRST_SEEN_AT,
    Date.now() - LINUX_APP_BANNER_MIN_AGE_MS - 1,
  );
  rerender({ eligible: true });
  expect(result.current.ageEligible).toBe(true);
  rerender({ eligible: false });
  expect(result.current.ageEligible).toBe(false);
});

test("dismissal survives remount and does not dismiss the other platform", () => {
  const linux = renderHook(() => useLinuxNudgeState(true));
  act(() => linux.result.current.handleBannerDismiss());
  expect(linux.result.current.bannerShouldShow).toBe(false);
  linux.unmount();
  expect(
    renderHook(() => useLinuxNudgeState(true)).result.current.bannerShouldShow,
  ).toBe(false);
  expect(
    renderHook(() => useMacOsNudgeState()).result.current.bannerShouldShow,
  ).toBe(true);
});

test("download opens the shared page and persists only the selected platform", () => {
  const open = mock(() => null);
  window.open = open as typeof window.open;
  const linux = renderHook(() => useLinuxNudgeState(true));
  act(() => linux.result.current.handleDownload());
  expect(open).toHaveBeenCalledWith(
    VELLUM_DOWNLOADS_URL,
    "_blank",
    "noopener,noreferrer",
  );
  expect(linux.result.current.bannerShouldShow).toBe(false);
  expect(emitEvent).toHaveBeenCalledWith("click", "banner", "linux");
  expect(readLinuxAppDownloaded()).toBe(true);
  expect(readMacOsAppDownloaded()).toBe(false);
});

afterAll(() => {
  emitEvent.mockRestore();
});
