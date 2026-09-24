import {
  afterAll,
  afterEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import type { PermissionsService } from "./permissions-service";
import type { PermissionGuideState } from "@vellumai/ipc-contract";

const handles = new Map<string, Function>();
const listeners = new Map<string, Function>();
const intervals: (() => void)[] = [];
const intervalSpy = spyOn(globalThis, "setInterval").mockImplementation(
  Object.assign((callback: () => void) => {
    intervals.push(callback);
    return setTimeout(() => undefined, 1_000_000);
  }, setInterval),
);
afterAll(() => intervalSpy.mockRestore());
const events: unknown[] = [];
let granted = false;
let restricted = false;
let settingsOpenFails = false;
let iconWait: Promise<void> | undefined;
let iconEmpty = false;
let avatarPng: Buffer | null = null;
let accentHex: string | null = null;
let avatarEmpty = false;
let avatarChanged = () => {};
const settingsBounds = { x: 100, y: 50, width: 700, height: 700 };
const mainSettings = {
  windowId: 1,
  bundleId: "com.apple.systempreferences",
  bounds: settingsBounds,
};
let settingsWindows = [mainSettings];
let windowsWait: Promise<void> | undefined;
const workArea = { x: 0, y: 25, width: 1440, height: 875 };
const windows = new Map<string, FakeWindow>();
class FakeWindow {
  destroyed = false;
  alwaysOnTop = true;
  bounds = { x: 100, y: 100, width: 660, height: 780 };
  callbacks = new Map<string, () => void>();
  webContents = {
    send: (_channel: string, value: unknown) => events.push(value),
    isDestroyed: () => this.destroyed,
    startDrag: mock(() => undefined),
  };
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return false;
  }
  setBounds(bounds: typeof this.bounds) {
    this.bounds = bounds;
  }
  getBounds() {
    return this.bounds;
  }
  setAlwaysOnTop(value: boolean) {
    this.alwaysOnTop = value;
  }
  showInactive = mock(() => undefined);
  show = mock(() => undefined);
  center() {}
  once(event: string, fn: () => void) {
    this.callbacks.set(event, fn);
  }
  on(event: string, fn: () => void) {
    this.callbacks.set(event, fn);
  }
  destroy() {
    this.destroyed = true;
    this.callbacks.get("closed")?.();
  }
}
const icon = {
  isEmpty: () => iconEmpty,
  toDataURL: () => "data:image/png;base64,icon",
  resize: () => icon,
};
const avatarIcon = {
  isEmpty: () => avatarEmpty,
  toDataURL: () => "data:image/png;base64,avatar",
  resize: () => avatarIcon,
};
mock.module(
  "@vellumai/electron-desktop/avatar",
  (): Partial<typeof import("@vellumai/electron-desktop/avatar")> => ({
    getAvatarPng: () => avatarPng,
    getAccentHex: () => accentHex,
    onAvatarChange: (callback: () => void) => {
      avatarChanged = callback;
      return () => {};
    },
  }),
);
mock.module("node:fs/promises", () => ({
  stat: async () => ({ isDirectory: () => true }),
}));
mock.module("electron", () => ({
  nativeImage: { createFromBuffer: () => avatarIcon },
  app: {
    getPath: () => "/Applications/Vellum.app/Contents/MacOS/Vellum",
    getFileIcon: async (_file: string, options: { size: string }) => {
      // Electron does not support the large icon size on macOS.
      expect(["small", "normal"]).toContain(options.size);
      await iconWait;
      return icon;
    },
    on: () => undefined,
  },
  BrowserWindow: {
    getAllWindows: () => [...windows.values()],
    fromWebContents: (sender: unknown) =>
      [...windows.values()].find((win) => win.webContents === sender),
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 500, y: 400 }),
    getDisplayNearestPoint: () => ({ workArea }),
    getDisplayMatching: () => ({ workArea }),
  },
  shell: { showItemInFolder: mock(() => undefined) },
  systemPreferences: {
    getAnimationSettings: () => ({ prefersReducedMotion: true }),
  },
}));
mock.module("@vellumai/electron-desktop/floating-window", () => ({
  createFloatingWindow: ({ kind }: { kind: string }) => {
    const win = new FakeWindow();
    windows.set(kind, win);
    return win;
  },
}));
mock.module("./ipc", () => ({
  handle: (channel: string, schema: { parse: Function }, fn: Function) =>
    handles.set(channel, (args: unknown[], event: unknown) =>
      fn(schema.parse(args), event),
    ),
  on: (channel: string, _schema: unknown, fn: Function) =>
    listeners.set(channel, fn),
}));
mock.module("./companion-capture-sources", () => ({
  defaultCaptureSourceDeps: {
    listWindows: async () => {
      await windowsWait;
      return settingsWindows;
    },
  },
}));
mock.module("./sidecar/mac-helper-path", () => ({
  getMacHelperAppPath: () =>
    "/Applications/Vellum.app/Contents/Resources/bin/Vellum Helper.app",
}));
const preparePresentation = mock(() => undefined);
mock.module("./permissions-service", () => ({
  preparePermissionPresentation: preparePresentation,
  openPermissionSettingsPane: async () => {
    if (settingsOpenFails) {
      throw new Error("Settings failed");
    }
  },
}));
mock.module("./logger", () => ({ default: { warn: () => undefined } }));
const { installCompanionPermissionGuide } =
  await import("./companion-permission-guide");
const state = () =>
  Object.fromEntries(
    ["screen", "inputMonitoring"].map((kind) => [
      kind,
      { status: restricted ? "restricted" : granted ? "granted" : "denied" },
    ]),
  );
installCompanionPermissionGuide({
  state: async () => state(),
  refresh: async () => state(),
} as unknown as PermissionsService);
const get = (): PermissionGuideState | null =>
  handles.get("vellum:permissions:guide:get")!([]);
const begin = (
  kind = "screen",
  sender: unknown = new FakeWindow().webContents,
) => handles.get("vellum:permissions:setup:begin")!([kind], { sender });
const flush = async () => {
  await new Promise((resolve) => setImmediate(resolve));
};
const dismiss = () => {
  const current = get();
  if (current) {
    listeners.get("vellum:permissions:guide:dismiss")!([current.id], {
      sender: windows.get("permission-guide")!.webContents,
    });
  }
};
afterEach(() => {
  dismiss();
  intervals.length = 0;
  windows.clear();
  events.length = 0;
  granted = false;
  restricted = false;
  settingsOpenFails = false;
  iconWait = undefined;
  iconEmpty = false;
  avatarPng = null;
  accentHex = null;
  avatarEmpty = false;
  settingsWindows = [mainSettings];
  windowsWait = undefined;
  preparePresentation.mockClear();
});

describe("native permission guide", () => {
  test("shows and drags the assistant avatar while preserving the helper bundle payload", async () => {
    avatarPng = Buffer.from("avatar");
    accentHex = "#e9642f";
    await begin();
    const session = get()!;
    expect(session.appIcon).toBe(avatarIcon.toDataURL());
    expect(session.accentHex).toBe(accentHex);
    const win = windows.get("permission-guide")!;
    listeners.get("vellum:permissions:guide:drag")!([session.id], {
      sender: win.webContents,
    });
    expect(win.webContents.startDrag).toHaveBeenCalledWith({
      file: "/Applications/Vellum.app/Contents/Resources/bin/Vellum Helper.app",
      icon: avatarIcon,
    });
  });

  test("updates an open guide when the avatar arrives and restores the fallback when cleared", async () => {
    await begin();
    expect(get()!.appIcon).toBe(icon.toDataURL());
    avatarPng = Buffer.from("avatar");
    accentHex = "#e9642f";
    avatarChanged();
    expect(get()!.appIcon).toBe(avatarIcon.toDataURL());
    expect(get()!.accentHex).toBe(accentHex);
    expect(events.at(-1)).toEqual(get());
    avatarPng = null;
    accentHex = null;
    avatarChanged();
    expect(get()!.appIcon).toBe(icon.toDataURL());
    expect(get()!.accentHex).toBeUndefined();
  });

  test("falls back to the helper icon when the cached avatar cannot be decoded", async () => {
    avatarPng = Buffer.from("invalid image");
    avatarEmpty = true;
    await begin();
    expect(get()!.appIcon).toBe(icon.toDataURL());
  });

  test.each([
    "accessibility",
    "microphone",
    "speechRecognition",
    "automation",
    "notifications",
  ])("rejects %s outside the companion helper permissions", (kind) => {
    expect(() => begin(kind)).toThrow();
    expect(get()).toBeNull();
    expect(windows.has("permission-guide")).toBe(false);
  });

  test("cancels a pending app lookup when another permission is selected", async () => {
    let resolve: () => void = () => undefined;
    iconWait = new Promise<void>((done) => {
      resolve = done;
    });
    const pending = begin();
    await flush();
    iconWait = undefined;
    await begin("inputMonitoring");
    resolve();
    await pending;
    expect(get()!.kind).toBe("inputMonitoring");
  });

  test("drags the helper bundle only from its live guide sender", async () => {
    await begin();
    const session = get()!;
    expect(session.appName).toBe("Vellum Helper");
    const win = windows.get("permission-guide")!;
    const drag = listeners.get("vellum:permissions:guide:drag")!;
    drag([session.id], { sender: {} });
    drag([session.id + 1], { sender: win.webContents });
    expect(win.webContents.startDrag).not.toHaveBeenCalled();
    drag([session.id], { sender: win.webContents });
    expect(win.webContents.startDrag).toHaveBeenCalledWith({
      file: "/Applications/Vellum.app/Contents/Resources/bin/Vellum Helper.app",
      icon,
    });
  });

  test("follows Settings after paint and closes when the actual grant arrives", async () => {
    const owner = new FakeWindow();
    windows.set("companion", owner);
    await begin("screen", owner.webContents);
    const win = windows.get("permission-guide")!;
    listeners.get("vellum:permissions:guide:ready")!([get()!.id, 148], {
      sender: win.webContents,
    });
    await flush();
    expect(win.bounds.x).toBe(224);
    granted = true;
    intervals[0]!();
    await flush();
    expect(get()).toBeNull();
    expect(win.destroyed).toBe(true);
    expect(owner.show).not.toHaveBeenCalled();
    expect(owner.showInactive).not.toHaveBeenCalled();
  });

  test("a replaced guide cannot drag a stale application", async () => {
    await begin();
    const previous = get()!;
    const previousWindow = windows.get("permission-guide")!;
    await begin("inputMonitoring");
    expect(previousWindow.destroyed).toBe(true);
    expect(get()!.kind).toBe("inputMonitoring");
    listeners.get("vellum:permissions:guide:drag")!([previous.id], {
      sender: previousWindow.webContents,
    });
    expect(previousWindow.webContents.startDrag).not.toHaveBeenCalled();
  });

  test("does not create guides for granted or managed permissions", async () => {
    granted = true;
    await begin();
    expect(get()).toBeNull();
    granted = false;
    restricted = true;
    await begin();
    expect(get()).toBeNull();
  });

  test("cleans up if System Settings cannot open", async () => {
    settingsOpenFails = true;
    await expect(begin()).rejects.toThrow("Settings failed");
    expect(get()).toBeNull();
    expect(windows.get("permission-guide")!.destroyed).toBe(true);
  });

  test("does not create a drag source with an empty icon", async () => {
    iconEmpty = true;
    await expect(begin()).rejects.toThrow("unavailable");
    expect(get()).toBeNull();
  });
  test("keeps following the main Settings window when authentication comes forward", async () => {
    const dialog = {
      ...mainSettings,
      windowId: 2,
      bounds: { x: 200, y: 150, width: 260, height: 300 },
    };
    settingsWindows = [dialog, mainSettings];
    await begin();
    const win = windows.get("permission-guide")!;
    listeners.get("vellum:permissions:guide:ready")!([get()!.id, 148], {
      sender: win.webContents,
    });
    await flush();
    expect(win.bounds).toEqual({ x: 224, y: 586, width: 560, height: 148 });
    settingsWindows = [
      { ...dialog, bounds: { x: 0, y: 0, width: 1300, height: 850 } },
      mainSettings,
    ];
    intervals[1]!();
    await flush();
    expect(win.bounds).toEqual({ x: 224, y: 586, width: 560, height: 148 });
  });

  test("yields before native drag and ignores pending positioning or renderer resize", async () => {
    await begin();
    const win = windows.get("permission-guide")!;
    const ready = listeners.get("vellum:permissions:guide:ready")!;
    ready([get()!.id, 148], { sender: win.webContents });
    await flush();
    const previous = { ...win.bounds };
    let resolve!: () => void;
    windowsWait = new Promise<void>((done) => {
      resolve = done;
    });
    intervals[1]!();
    win.webContents.startDrag.mockImplementation(() => {
      expect(win.alwaysOnTop).toBe(false);
      expect(preparePresentation).toHaveBeenCalledTimes(1);
    });
    listeners.get("vellum:permissions:guide:drag")!([get()!.id], {
      sender: win.webContents,
    });
    const shows = win.showInactive.mock.calls.length;
    ready([get()!.id, 190], { sender: win.webContents });
    settingsWindows = [
      { ...mainSettings, bounds: { x: 500, y: 200, width: 300, height: 400 } },
    ];
    resolve();
    await flush();
    expect(win.alwaysOnTop).toBe(false);
    expect(win.bounds).toEqual(previous);
    expect(win.showInactive).toHaveBeenCalledTimes(shows);
    granted = true;
    intervals[0]!();
    await flush();
    expect(win.destroyed).toBe(true);
  });

  test("restores the guide if native dragging fails", async () => {
    await begin();
    const win = windows.get("permission-guide")!;
    win.webContents.startDrag.mockImplementation(() => {
      throw new Error("drag failed");
    });
    listeners.get("vellum:permissions:guide:drag")!([get()!.id], {
      sender: win.webContents,
    });
    expect(win.alwaysOnTop).toBe(true);
    expect(get()!.error).toBe(true);
  });

  test("yields to Finder and only returns to the originating coachmark on Back", async () => {
    const owner = new FakeWindow();
    windows.set("companion", owner);
    await begin("screen", owner.webContents);
    const win = windows.get("permission-guide")!;
    handles.get("vellum:permissions:guide:reveal")!([get()!.id], {
      sender: win.webContents,
    });
    expect(win.alwaysOnTop).toBe(false);
    dismiss();
    expect(owner.show).toHaveBeenCalledTimes(1);
  });

  test("only the originating tour can cancel a guide or pending lookup", async () => {
    const owner = new FakeWindow();
    let resolve!: () => void;
    iconWait = new Promise<void>((done) => {
      resolve = done;
    });
    const pending = begin("screen", owner.webContents);
    await flush();
    const cancel = listeners.get("vellum:permissions:guide:cancel")!;
    cancel([], { sender: {} });
    cancel([], { sender: owner.webContents });
    resolve();
    await pending;
    expect(get()).toBeNull();
    expect(windows.has("permission-guide")).toBe(false);
    iconWait = undefined;
    await begin("screen", owner.webContents);
    cancel([], { sender: {} });
    expect(get()).not.toBeNull();
    cancel([], { sender: owner.webContents });
    expect(get()).toBeNull();
    expect(owner.show).not.toHaveBeenCalled();
  });
});
