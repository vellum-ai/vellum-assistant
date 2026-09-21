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

function item(
  kind: SystemPermissionKind,
  status: SystemPermissionStateItem["status"],
): SystemPermissionStateItem {
  return {
    kind,
    status,
    canRequest: status === "not-determined",
    canOpenSettings: status !== "granted",
    requiresRestart: false,
  };
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
    ["talk", "microphone"],
    ["key", "inputMonitoring"],
    ["share", "screen"],
    ["try", "microphone"],
  ] as const)("prepares %s without prompting on mount", async (beat, kind) => {
    const view = setup(beat);
    await known(view);
    expect(view.result.current?.kind).toBe(kind);
    expect(request).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
    expect(companionIntroNeedsPermission(view.result.current)).toBe(true);
  });
  test.each(["idle", "meet", "draw", "mute"] as const)(
    "prepares permission status in the background on %s",
    async (beat) => {
      const view = setup(beat);
      expect(view.result.current).toBeNull();
      await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
      expect(request).not.toHaveBeenCalled();
      expect(settings).not.toHaveBeenCalled();
    },
  );
  test("does not read permissions outside the tour", () => {
    const view = setup(null);
    expect(view.result.current).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
  test("retains prefetched grants across steps and background checks", async () => {
    current = permissions("granted");
    const view = setup("meet");
    await act(async () => {});
    let resolve!: (state: SystemPermissionsState) => void;
    read.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    for (const beat of ["talk", "key", "share", "draw", "try"] as const) {
      view.rerender({ beat });
      expect(companionIntroNeedsPermission(view.result.current)).toBe(false);
      if (beat !== "draw") {
        expect(view.result.current?.state.phase).toBe("known");
      }
    }
    await act(async () => resolve(current));
    expect(view.result.current?.state.phase).toBe("known");
  });
  test("retains the last result during periodic permission checks", async () => {
    jest.useFakeTimers();
    current = permissions("granted");
    const view = setup("talk");
    await act(async () => {});
    let resolve!: (state: SystemPermissionsState) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => jest.advanceTimersByTime(2_000));
    expect(companionIntroNeedsPermission(view.result.current)).toBe(false);
    expect(view.result.current?.state.phase).toBe("known");
    await act(async () => resolve(current));
    expect(view.result.current?.state.phase).toBe("known");
  });
  test("only requests the permission of the clicked step", async () => {
    const view = setup("talk");
    await known(view);
    act(() => view.result.current?.enable());
    await waitFor(() => expect(request).toHaveBeenCalledWith("microphone"));
    await known(view);
    expect(companionIntroNeedsPermission(view.result.current)).toBe(true);
  });
  test("uses the Settings action for shortcut setup", async () => {
    const view = setup("key");
    await known(view);
    act(() => view.result.current?.enable());
    await waitFor(() =>
      expect(settings).toHaveBeenCalledWith("inputMonitoring"),
    );
    expect(request).not.toHaveBeenCalled();
  });
  test("requests screen access before offering the Settings fallback", async () => {
    current.screen = { ...current.screen, status: "denied", canRequest: true };
    const view = setup("share");
    await known(view);
    act(() => view.result.current?.enable());
    await waitFor(() => expect(request).toHaveBeenCalledWith("screen"));
    expect(settings).not.toHaveBeenCalled();
  });
  test("observes a Settings grant on the same step", async () => {
    current = permissions("denied");
    const view = setup("share");
    await known(view);
    act(() => view.result.current?.enable());
    await waitFor(() => expect(settings).toHaveBeenCalledWith("screen"));
    await known(view);
    current = permissions("granted");
    act(() => listener?.(current));
    expect(companionIntroNeedsPermission(view.result.current)).toBe(false);
    expect(view.result.current?.kind).toBe("screen");
  });
  test("directs a previously denied microphone to Settings", async () => {
    current = permissions("denied");
    const view = setup("try");
    await known(view);
    act(() => view.result.current?.enable());
    await waitFor(() => expect(settings).toHaveBeenCalledWith("microphone"));
    expect(request).not.toHaveBeenCalled();
  });
  test("skips requests for granted or restricted permissions", async () => {
    current = permissions("restricted");
    const view = setup("key");
    await known(view);
    act(() => view.result.current?.enable());
    await known(view);
    expect(request).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
    current = permissions("granted");
    act(() => listener?.(current));
    expect(companionIntroNeedsPermission(view.result.current)).toBe(false);
  });
  test("does not open a prompt after the user skips a pending read", async () => {
    const view = setup("talk");
    await known(view);
    let resolve!: (state: SystemPermissionsState) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    act(() => view.result.current?.enable());
    view.rerender({ beat: "key" });
    await act(async () => resolve(current));
    expect(request).not.toHaveBeenCalled();
    expect(view.result.current?.kind).toBe("inputMonitoring");
  });
  test("ignores a request result after moving to another step", async () => {
    const view = setup("talk");
    await known(view);
    let resolve!: (value: SystemPermissionStateItem) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    act(() => view.result.current?.enable());
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    view.rerender({ beat: "share" });
    await known(view);
    await act(async () => resolve(item("microphone", "granted")));
    expect(view.result.current?.kind).toBe("screen");
    expect(companionIntroNeedsPermission(view.result.current)).toBe(true);
  });
  test("deduplicates repeated clicks while a prompt is pending", async () => {
    const view = setup("talk");
    await known(view);
    let resolve!: (value: SystemPermissionStateItem) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    act(() => {
      view.result.current?.enable();
      view.result.current?.enable();
    });
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await act(async () => resolve(item("microphone", "granted")));
    expect(companionIntroNeedsPermission(view.result.current)).toBe(false);
  });
  test("keeps a newer grant when an older read returns", async () => {
    let resolve!: (state: SystemPermissionsState) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = setup("talk");
    act(() => listener?.(permissions("granted")));
    await act(async () => resolve(current));
    expect(companionIntroNeedsPermission(view.result.current)).toBe(false);
  });
  test("preserves pushed grants when an older request result returns", async () => {
    const view = setup("talk");
    await known(view);
    let resolve!: (value: SystemPermissionStateItem) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    act(() => view.result.current?.enable());
    await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    current = permissions("granted");
    act(() => listener?.(current));
    expect(view.result.current?.state.phase).toBe("requesting");
    await act(async () => resolve(item("microphone", "denied")));
    expect(companionIntroNeedsPermission(view.result.current)).toBe(false);
    read.mockImplementation(() => new Promise(() => {}));
    view.rerender({ beat: "share" });
    expect(companionIntroNeedsPermission(view.result.current)).toBe(false);
    expect(view.result.current?.state.phase).toBe("known");
  });
  test("reports a failed request and keeps setup available", async () => {
    const view = setup("talk");
    await known(view);
    request.mockRejectedValueOnce(new Error("permission request failed"));
    act(() => view.result.current?.enable());
    await waitFor(() => expect(view.result.current?.state.phase).toBe("error"));
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(companionIntroNeedsPermission(view.result.current)).toBe(true);
  });
  test("keeps one polling loop when an older read finishes after setup", async () => {
    jest.useFakeTimers();
    let resolve!: (state: SystemPermissionsState) => void;
    read.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const view = setup("talk");
    act(() => listener?.(current));
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
    const view = setup("talk");
    await waitFor(() => expect(view.result.current).toBeNull());
    expect(companionIntroNeedsPermission(view.result.current)).toBe(false);
  });
});
