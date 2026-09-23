import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from "bun:test";
import type { CompanionIntroBeat } from "@vellumai/ipc-contract";
import type {
  SystemPermissionKind,
  SystemPermissionsState,
  SystemPermissionStateItem,
} from "@/runtime/system-permissions";

import { permissionItem as item } from "./companion-intro-fixtures";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function permissions(
  status: SystemPermissionStateItem["status"],
): SystemPermissionsState {
  return Object.fromEntries(
    [
      "microphone",
      "inputMonitoring",
      "screen",
      "accessibility",
      "speechRecognition",
      "automation",
      "notifications",
    ].map((kind) => [kind, item(kind as SystemPermissionKind, status)]),
  ) as SystemPermissionsState;
}
let current = permissions("not-determined");
let listener: ((state: SystemPermissionsState) => void) | null = null;
const read = mock(async (): Promise<SystemPermissionsState | null> => current);
const request = mock(async (kind: SystemPermissionKind) => current[kind]);
const settings = mock(async (kind: SystemPermissionKind) => current[kind]);
let setupSupported = false;
const cancelGuide = mock(() => undefined);
const beginGuide = mock(async (kind: SystemPermissionKind) => current[kind]);
const foreground = mock(async () => undefined);
const frontmost = mock(async (): Promise<string | null> => "com.example.vellum");
mock.module("@/runtime/running-apps", () => ({
  frontmostApp: frontmost,
}));
mock.module("@/runtime/main-window", () => ({
  ensureMainWindowVisible: foreground,
}));
mock.module("@/runtime/permission-setup", () => ({
  supportsPermissionSetup: () => setupSupported,
  beginPermissionGuide: beginGuide,
  cancelPermissionGuide: cancelGuide,
}));
const reportError = mock(() => {});
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: reportError,
}));
mock.module("@/runtime/system-permissions", () => ({
  getSystemPermissionsState: read,
  requestSystemPermission: request,
  openSystemPermissionSettings: settings,
  subscribeToSystemPermissions: (callback: typeof listener) => {
    listener = callback;
    return () => {
      listener = null;
    };
  },
}));
const { useCompanionIntroPermission, companionIntroNeedsPermission } =
  await import("./use-companion-intro-permission");

beforeEach(() => {
  setupSupported = false;
  beginGuide.mockClear();
  cancelGuide.mockClear();
  foreground.mockReset();
  foreground.mockImplementation(async () => undefined);
  frontmost.mockReset();
  frontmost.mockImplementation(async () => "com.example.vellum");
  current = permissions("not-determined");
  read.mockReset();
  read.mockImplementation(async () => current);
  request.mockReset();
  request.mockImplementation(async (kind) => current[kind]);
  settings.mockClear();
  reportError.mockClear();
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

function setup(beat: CompanionIntroBeat | null) {
  return renderHook(({ beat }) => useCompanionIntroPermission(beat), {
    initialProps: { beat },
  });
}
async function known(view: ReturnType<typeof setup>) {
  await waitFor(() => expect(view.result.current?.state.phase).toBe("known"));
}

describe("companion tour permission setup", () => {
  test.each([
    ["key", "inputMonitoring"],
    ["share", "screen"],
  ] as const)(
    "%s opens the drag guide when the shell supports it",
    async (beat, kind) => {
      setupSupported = true;
      const view = setup(beat);
      await known(view);
      act(() => view.result.current?.enable());
      await known(view);
      expect(beginGuide).toHaveBeenCalledWith(kind, undefined);
      expect(request).not.toHaveBeenCalled();
      expect(settings).not.toHaveBeenCalled();
      current = permissions("granted");
      await act(async () => listener?.(current));
      expect(companionIntroNeedsPermission(view.result.current)).toBe(false);
      expect(cancelGuide).toHaveBeenCalledTimes(1);
      expect(foreground).toHaveBeenCalledTimes(1);
      await act(async () => listener?.(current));
      expect(foreground).toHaveBeenCalledTimes(1);
    },
  );

  test("detaches from the coachmark and cancels when its step is left", async () => {
    setupSupported = true;
    const view = setup("key");
    await known(view);
    const source = { x: 20, y: 40, width: 260, height: 120 };
    act(() => view.result.current?.enable(source));
    await known(view);
    expect(beginGuide).toHaveBeenCalledWith("inputMonitoring", source);
    view.rerender({ beat: "share" });
    expect(cancelGuide).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(cancelGuide).toHaveBeenCalledTimes(2);
  });

  test("only requests the three permissions used by companion controls", async () => {
    setupSupported = true;
    const view = setup("idle");
    for (const beat of ["key", "share", "try"] as const) {
      view.rerender({ beat });
      await known(view);
      act(() => view.result.current?.enable());
      await known(view);
    }
    expect(request.mock.calls.map(([kind]) => kind)).toEqual(["microphone"]);
    expect(beginGuide.mock.calls.map(([kind]) => kind)).toEqual([
      "inputMonitoring",
      "screen",
    ]);
    expect(settings).not.toHaveBeenCalled();
  });

  test.each([
    ["try", "microphone", "not-determined", true, "request"],
    ["key", "inputMonitoring", "not-determined", true, "settings"],
    ["share", "screen", "denied", true, "request"],
    ["share", "screen", "denied", false, "settings"],
    ["try", "microphone", "denied", true, "settings"],
  ] as const)(
    "%s uses %s %s (canRequest=%s) via %s",
    async (beat, kind, status, canRequest, action) => {
      current[kind] = { ...item(kind, status), canRequest };
      const view = setup(beat);
      await known(view);
      expect(view.result.current?.kind).toBe(kind);
      expect(foreground).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(settings).not.toHaveBeenCalled();
      act(() => view.result.current?.enable());
      await known(view);
      expect(action === "request" ? request : settings).toHaveBeenCalledWith(
        kind,
      );
      expect(action === "request" ? settings : request).not.toHaveBeenCalled();
      expect(companionIntroNeedsPermission(view.result.current)).toBe(true);
      current = permissions("granted");
      await act(async () => listener?.(current));
      expect(companionIntroNeedsPermission(view.result.current)).toBe(false);
      expect(view.result.current?.kind).toBe(kind);
      expect(foreground).toHaveBeenCalledTimes(1);
    },
  );
  test.each(["idle", "meet", "draw", "mute"] as const)(
    "prepares permission status in the background on %s",
    async (beat) => {
      const view = setup(beat);
      expect(view.result.current).toBeNull();
      await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      expect(request).not.toHaveBeenCalled();
      expect(settings).not.toHaveBeenCalled();
      expect(foreground).not.toHaveBeenCalled();
    },
  );
  test("the Talk rehearsal never asks for microphone access", async () => {
    const view = setup("talk");
    await act(async () => {});
    expect(view.result.current).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
  });
  test("does not read permissions outside the tour", () => {
    const view = setup(null);
    expect(view.result.current).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
  test("retains prefetched grants across steps and background checks", async () => {
    current = permissions("granted");
    const view = setup("meet");
    await act(async () => {});
    const { promise, resolve } = deferred<SystemPermissionsState>();
    read.mockReturnValue(promise);
    for (const beat of ["talk", "key", "share", "draw", "try"] as const) {
      view.rerender({ beat });
      expect(companionIntroNeedsPermission(view.result.current)).toBe(false);
      if (beat !== "draw" && beat !== "talk") {
        expect(view.result.current?.state.phase).toBe("known");
      }
    }
    await act(async () => resolve(current));
    expect(view.result.current?.state.phase).toBe("known");
  });
  test("retains the last result during periodic permission checks", async () => {
    jest.useFakeTimers();
    current = permissions("granted");
    const view = setup("try");
    await act(async () => {});
    const { promise, resolve } = deferred<SystemPermissionsState>();
    read.mockReturnValueOnce(promise);
    await act(async () => jest.advanceTimersByTime(2_000));
    expect(companionIntroNeedsPermission(view.result.current)).toBe(false);
    expect(view.result.current?.state.phase).toBe("known");
    await act(async () => jest.advanceTimersByTime(2_000));
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => resolve(current));
    expect(view.result.current?.state.phase).toBe("known");
  });
  test.each(["granted", "restricted"] as const)(
    "does not request %s permissions",
    async (status) => {
      current = permissions(status);
      const view = setup("key");
      await known(view);
      act(() => view.result.current?.enable());
      await known(view);
      expect(request).not.toHaveBeenCalled();
      expect(settings).not.toHaveBeenCalled();
      expect(foreground).not.toHaveBeenCalled();
    },
  );
  test("does not open a prompt after the user skips a pending read", async () => {
    const view = setup("try");
    await known(view);
    const { promise, resolve } = deferred<SystemPermissionsState>();
    read.mockReturnValueOnce(promise);
    act(() => view.result.current?.enable());
    view.rerender({ beat: "key" });
    await act(async () => resolve(current));
    expect(request).not.toHaveBeenCalled();
    expect(view.result.current?.kind).toBe("inputMonitoring");
  });
  test("ignores a request result after moving to another step", async () => {
    const view = setup("try");
    await known(view);
    const { promise, resolve } = deferred<SystemPermissionStateItem>();
    request.mockReturnValueOnce(promise);
    act(() => view.result.current?.enable());
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    view.rerender({ beat: "share" });
    await known(view);
    await act(async () => resolve(item("microphone", "granted")));
    expect(view.result.current?.kind).toBe("screen");
    expect(companionIntroNeedsPermission(view.result.current)).toBe(true);
    expect(foreground).not.toHaveBeenCalled();
  });
  test("keeps a newer grant when an older read returns", async () => {
    const { promise, resolve } = deferred<SystemPermissionsState>();
    read.mockReturnValueOnce(promise);
    const view = setup("try");
    act(() => listener?.(permissions("granted")));
    await act(async () => resolve(current));
    expect(companionIntroNeedsPermission(view.result.current)).toBe(false);
  });
  test("deduplicates requests and preserves newer pushed grants", async () => {
    const view = setup("try");
    await known(view);
    const { promise, resolve } = deferred<SystemPermissionStateItem>();
    request.mockReturnValueOnce(promise);
    act(() => {
      view.result.current?.enable();
      view.result.current?.enable();
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    current = permissions("granted");
    await act(async () => listener?.(current));
    expect(view.result.current?.state.phase).toBe("requesting");
    expect(foreground).not.toHaveBeenCalled();
    await act(async () => resolve(item("microphone", "denied")));
    expect(companionIntroNeedsPermission(view.result.current)).toBe(false);
    expect(foreground).toHaveBeenCalledTimes(1);
    read.mockImplementation(() => new Promise(() => {}));
    view.rerender({ beat: "share" });
    expect(companionIntroNeedsPermission(view.result.current)).toBe(false);
    expect(view.result.current?.state.phase).toBe("known");
  });
  test("reports a failed request and keeps setup available", async () => {
    const view = setup("try");
    await known(view);
    request.mockRejectedValueOnce(new Error("permission request failed"));
    act(() => view.result.current?.enable());
    await waitFor(() => expect(view.result.current?.state.phase).toBe("error"));
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(companionIntroNeedsPermission(view.result.current)).toBe(true);
    act(() => listener?.(permissions("granted")));
    expect(foreground).not.toHaveBeenCalled();
  });
  test("returns after the microphone prompt resolves with a grant", async () => {
    const view = setup("try");
    await known(view);
    request.mockResolvedValueOnce(item("microphone", "granted"));
    act(() => view.result.current?.enable());
    await known(view);
    expect(foreground).toHaveBeenCalledTimes(1);
  });
  test("closes the drag guide before returning after a fresh permission read", async () => {
    jest.useFakeTimers();
    setupSupported = true;
    const view = setup("share");
    await act(async () => {});
    await act(async () => view.result.current?.enable());
    const refreshed = deferred<SystemPermissionsState>();
    read.mockReturnValueOnce(refreshed.promise);
    await act(async () => jest.advanceTimersByTime(2_000));
    expect(foreground).not.toHaveBeenCalled();
    foreground.mockImplementationOnce(async () => {
      expect(cancelGuide).toHaveBeenCalledTimes(1);
    });
    await act(async () => refreshed.resolve(permissions("granted")));
    expect(foreground).toHaveBeenCalledTimes(1);
    current = permissions("granted");
    await act(async () => jest.advanceTimersByTime(2_000));
    expect(foreground).toHaveBeenCalledTimes(1);
  });
  test("does not return for grants that were not requested by this tour", async () => {
    const view = setup("try");
    await known(view);
    act(() => listener?.(permissions("granted")));
    expect(foreground).not.toHaveBeenCalled();
  });
  test.each(["key", "share", "try"] as const)(
    "%s waits until Settings leaves the foreground before returning",
    async (beat) => {
      jest.useFakeTimers();
      setupSupported = true;
      current = permissions("denied");
      frontmost.mockResolvedValue("com.apple.systempreferences");
      const view = setup(beat);
      await act(async () => {});
      await act(async () => view.result.current?.enable());
      current = permissions("granted");
      await act(async () => listener?.(current));
      await act(async () => jest.advanceTimersByTime(60_000));
      expect(companionIntroNeedsPermission(view.result.current)).toBe(false);
      expect(foreground).not.toHaveBeenCalled();
      frontmost.mockResolvedValue("com.example.vellum");
      await act(async () => jest.advanceTimersByTime(2_000));
      expect(foreground).toHaveBeenCalledTimes(1);
      await act(async () => jest.advanceTimersByTime(2_000));
      expect(foreground).toHaveBeenCalledTimes(1);
    },
  );
  test.each([null, "com.apple.SecurityAgent"])(
    "does not take focus while the foreground application is %s",
    async (bundleId) => {
      const view = setup("share");
      await known(view);
      act(() => view.result.current?.enable());
      await known(view);
      frontmost.mockResolvedValue(bundleId);
      await act(async () => listener?.(permissions("granted")));
      expect(foreground).not.toHaveBeenCalled();
    },
  );
  test("does not return if the tour is left during a foreground check", async () => {
    const view = setup("share");
    await known(view);
    act(() => view.result.current?.enable());
    await known(view);
    const checked = deferred<string | null>();
    frontmost.mockReturnValueOnce(checked.promise);
    act(() => listener?.(permissions("granted")));
    view.rerender({ beat: null });
    await act(async () => checked.resolve("com.example.vellum"));
    expect(foreground).not.toHaveBeenCalled();
  });
  test("does not return if access is revoked during a foreground check", async () => {
    const view = setup("share");
    await known(view);
    act(() => view.result.current?.enable());
    await known(view);
    const checked = deferred<string | null>();
    frontmost.mockReturnValueOnce(checked.promise);
    act(() => listener?.(permissions("granted")));
    act(() => listener?.(permissions("denied")));
    expect(frontmost).toHaveBeenCalledTimes(1);
    await act(async () => checked.resolve("com.example.vellum"));
    expect(foreground).not.toHaveBeenCalled();
  });
  test("waits for the requested permission rather than an unrelated grant", async () => {
    const view = setup("try");
    await known(view);
    act(() => view.result.current?.enable());
    await known(view);
    current.screen = item("screen", "granted");
    await act(async () => listener?.(current));
    expect(foreground).not.toHaveBeenCalled();
    current.microphone = item("microphone", "granted");
    await act(async () => listener?.(current));
    expect(foreground).toHaveBeenCalledTimes(1);
  });
  test("does not return after leaving a pending permission setup", async () => {
    setupSupported = true;
    const view = setup("share");
    await known(view);
    act(() => view.result.current?.enable());
    await known(view);
    const previousListener = listener;
    view.rerender({ beat: null });
    act(() => previousListener?.(permissions("granted")));
    expect(foreground).not.toHaveBeenCalled();
  });
  test("a foreground failure does not undo the grant or repeatedly steal focus", async () => {
    const view = setup("try");
    await known(view);
    foreground.mockRejectedValueOnce(new Error("window unavailable"));
    request.mockResolvedValueOnce(item("microphone", "granted"));
    act(() => view.result.current?.enable());
    await known(view);
    expect(companionIntroNeedsPermission(view.result.current)).toBe(false);
    expect(reportError).toHaveBeenCalledTimes(1);
    act(() => listener?.(permissions("granted")));
    expect(foreground).toHaveBeenCalledTimes(1);
  });
  test("keeps one polling loop when an older read finishes after setup", async () => {
    jest.useFakeTimers();
    const { promise, resolve } = deferred<SystemPermissionsState>();
    read.mockReturnValueOnce(promise);
    const view = setup("try");
    await act(async () => listener?.(current));
    await act(async () => view.result.current?.enable());
    expect(request).toHaveBeenCalledTimes(1);
    await act(async () => resolve(current));
    read.mockClear();
    await act(async () => {
      jest.advanceTimersByTime(2_000);
    });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(2_000);
    });
    expect(read).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => {
      jest.advanceTimersByTime(2_000);
    });
    expect(read).toHaveBeenCalledTimes(2);
  });
  test("supports shells without a permission bridge", async () => {
    read.mockResolvedValue(null);
    const view = setup("try");
    await waitFor(() => expect(view.result.current).toBeNull());
    expect(companionIntroNeedsPermission(view.result.current)).toBe(false);
  });
});
