import { beforeEach, describe, expect, mock, test } from "bun:test";

// `./main-window` (which `./dock` imports `current` /
// `onMainWindowVisibilityChange` from) transitively pulls in
// `./window-state`, which depends on the `electron-store` module —
// stub both so the pure-function tests below don't need a real
// store. The mocks are no-ops; the `computePolicy` matrix tests
// only exercise the pure path.
mock.module("./main-window", () => ({
  current: () => null,
  onMainWindowVisibilityChange: () => undefined,
}));

// `./avatar` and `./ipc` transitively reach `electron`'s `ipcMain`; stub the
// two seams `./dock` actually uses so the module loads without a real Electron
// runtime. `avatarBitmap` is the single knob the Dock-icon tests turn.
mock.module("./ipc", () => ({ handle: () => undefined, on: () => undefined }));
mock.module("./avatar", () => ({ onAvatarChange: () => () => undefined }));

const avatarBitmapMock = mock((_size: number): Buffer | null => null);
mock.module("./avatar-image", () => ({ avatarBitmap: avatarBitmapMock }));

const setIconMock = mock((_icon: unknown) => undefined);
const createFromBitmapMock = mock((_buf: Buffer, _opts: unknown) => ({
  __kind: "bitmap",
}));
const createEmptyMock = mock(() => ({ __kind: "empty" }));
mock.module("electron", () => ({
  app: { dock: { setIcon: setIconMock } },
  nativeImage: {
    createFromBitmap: createFromBitmapMock,
    createEmpty: createEmptyMock,
  },
}));

const {
  computePolicy,
  formatBadge,
  buildDockIcon,
  applyDockIcon,
  __resetForTesting,
} = await import("./dock");

// A 418×418 BGRA buffer the size `buildDockIcon` requests, so masking and
// compositing run over a real-sized canvas.
const DOCK_ICON_PX = 418;
const fakeAvatar = (): Buffer => Buffer.alloc(DOCK_ICON_PX * DOCK_ICON_PX * 4, 255);

beforeEach(() => {
  __resetForTesting();
  avatarBitmapMock.mockReset();
  avatarBitmapMock.mockReturnValue(null);
  setIconMock.mockClear();
  createFromBitmapMock.mockClear();
  createEmptyMock.mockClear();
});

describe("formatBadge", () => {
  test("returns empty string for zero", () => {
    expect(formatBadge(0)).toBe("");
  });

  test("returns empty string for negatives", () => {
    expect(formatBadge(-1)).toBe("");
    expect(formatBadge(-99)).toBe("");
  });

  test("returns empty string for NaN and ±Infinity", () => {
    expect(formatBadge(Number.NaN)).toBe("");
    expect(formatBadge(Number.POSITIVE_INFINITY)).toBe("");
    expect(formatBadge(Number.NEGATIVE_INFINITY)).toBe("");
  });

  test("passes through 1..99", () => {
    expect(formatBadge(1)).toBe("1");
    expect(formatBadge(42)).toBe("42");
    expect(formatBadge(99)).toBe("99");
  });

  test("truncates anything beyond 99 to \"99+\"", () => {
    expect(formatBadge(100)).toBe("99+");
    expect(formatBadge(1_000_000)).toBe("99+");
  });

  test("floors fractional counts in the 1..99 range", () => {
    expect(formatBadge(2.9)).toBe("2");
    expect(formatBadge(98.7)).toBe("98");
  });

  test("anything strictly greater than 99 truncates to \"99+\" before flooring", () => {
    // 99.0001 fails the `count > 99` check and bypasses `Math.floor`,
    // landing on `"99+"`. This is intentional — Swift Vellum caps at 99
    // and matching its cap avoids visual jitter at the boundary.
    expect(formatBadge(99.0001)).toBe("99+");
    expect(formatBadge(99.9)).toBe("99+");
  });
});

describe("computePolicy", () => {
  test("regular while the main window is visible (signed out, gate off)", () => {
    expect(computePolicy(true, false, false)).toBe("regular");
  });

  test("regular while signed in even when the main window is hidden", () => {
    expect(computePolicy(false, true, false)).toBe("regular");
    expect(computePolicy(false, true, true)).toBe("regular");
  });

  test("regular when signed out + main hidden AND accessory gate off", () => {
    expect(computePolicy(false, false, false)).toBe("regular");
  });

  test("accessory only when signed out + main hidden + gate on", () => {
    expect(computePolicy(false, false, true)).toBe("accessory");
  });

  test("main-window visibility overrides every other signal", () => {
    expect(computePolicy(true, false, true)).toBe("regular");
    expect(computePolicy(true, true, true)).toBe("regular");
  });
});

describe("buildDockIcon", () => {
  test("returns null when no avatar is cached, leaving the bundle icon in place", () => {
    avatarBitmapMock.mockReturnValue(null);
    expect(buildDockIcon()).toBeNull();
    expect(createFromBitmapMock).not.toHaveBeenCalled();
  });

  test("masks and composites the avatar into a 512px canvas when one exists", () => {
    avatarBitmapMock.mockReturnValue(fakeAvatar());
    const icon = buildDockIcon();

    expect(icon).not.toBeNull();
    expect(createFromBitmapMock).toHaveBeenCalledTimes(1);
    expect(avatarBitmapMock).toHaveBeenCalledWith(DOCK_ICON_PX);
    // The composited canvas is the padded 512px square, not the 418px artwork.
    const [, opts] = createFromBitmapMock.mock.calls[0]!;
    expect(opts).toEqual({ width: 512, height: 512 });
  });
});

describe("applyDockIcon", () => {
  test("sets the masked avatar icon when one is available", () => {
    avatarBitmapMock.mockReturnValue(fakeAvatar());
    applyDockIcon();
    expect(setIconMock).toHaveBeenCalledTimes(1);
    expect(setIconMock).toHaveBeenCalledWith({ __kind: "bitmap" });
  });

  test("never touches the Dock icon before an avatar is ever set", () => {
    avatarBitmapMock.mockReturnValue(null);
    applyDockIcon();
    expect(setIconMock).not.toHaveBeenCalled();
  });

  test("restores the bundle icon once a previously-set avatar is cleared", () => {
    avatarBitmapMock.mockReturnValue(fakeAvatar());
    applyDockIcon();
    setIconMock.mockClear();

    // Avatar cleared after one was applied → restore via an empty image.
    avatarBitmapMock.mockReturnValue(null);
    applyDockIcon();
    expect(createEmptyMock).toHaveBeenCalledTimes(1);
    expect(setIconMock).toHaveBeenCalledWith({ __kind: "empty" });

    // A second clear is a no-op: nothing to restore again.
    setIconMock.mockClear();
    applyDockIcon();
    expect(setIconMock).not.toHaveBeenCalled();
  });
});
