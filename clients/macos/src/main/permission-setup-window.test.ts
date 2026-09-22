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
let settingsPresenter: (kind: "screen") => Promise<boolean>;
let iconEmpty = false;
let settingsBounds = { x: 100, y: 50, width: 700, height: 700 };
const workArea = { x: 0, y: 25, width: 1440, height: 875 };
const windows = new Map<string, FakeWindow>();
class FakeWindow {
  destroyed = false;
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
  setAlwaysOnTop() {}
  showInactive() {}
  show() {}
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
mock.module("node:fs/promises", () => ({
  stat: async () => ({ isDirectory: () => true }),
}));
mock.module("electron", () => ({
  app: {
    getPath: () => "/Applications/Vellum.app/Contents/MacOS/Vellum",
    getFileIcon: async () => {
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
  getFloatingWindow: (kind: string) => windows.get(kind) ?? null,
}));
mock.module("./ipc", () => ({
  handle: (channel: string, _schema: unknown, fn: Function) =>
    handles.set(channel, fn),
  on: (channel: string, _schema: unknown, fn: Function) =>
    listeners.set(channel, fn),
}));
mock.module("./companion-capture-sources", () => ({
  defaultCaptureSourceDeps: {
    listWindows: async () => [
      { bundleId: "com.apple.systempreferences", bounds: settingsBounds },
    ],
  },
}));
mock.module("./sidecar/mac-helper-path", () => ({
  getMacHelperAppPath: () =>
    "/Applications/Vellum.app/Contents/Resources/bin/Vellum Helper.app",
}));
mock.module("./permissions-service", () => ({
  openPermissionSettingsPane: async () => {
    if (settingsOpenFails) {
      throw new Error("Settings failed");
    }
  },
}));
mock.module("./logger", () => ({ default: { warn: () => undefined } }));
const { installPermissionSetup } = await import("./permission-setup-window");
const state = () =>
  Object.fromEntries(
    ["accessibility", "screen", "inputMonitoring"].map((kind) => [
      kind,
      { status: restricted ? "restricted" : granted ? "granted" : "denied" },
    ]),
  );
installPermissionSetup({
  state: async () => state(),
  refresh: async () => state(),
  setSettingsPresenter: (presenter: typeof settingsPresenter) => {
    settingsPresenter = presenter;
  },
} as unknown as PermissionsService);
const get = (): PermissionGuideState | null =>
  handles.get("vellum:permissions:guide:get")!([]);
const begin = (kind = "screen") =>
  handles.get("vellum:permissions:setup:begin")!([kind], { sender: {} });
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
});

describe("native permission guide", () => {
  test("keeps ordinary Settings available for granted permissions or missing drag assets", async () => {
    granted = true;
    expect(await settingsPresenter("screen")).toBe(false);
    granted = false;
    iconEmpty = true;
    expect(await settingsPresenter("screen")).toBe(false);
    expect(get()).toBeNull();
  });

  test("cancels a pending app lookup when another permission is selected", async () => {
    let resolve: () => void = () => undefined;
    iconWait = new Promise<void>((done) => {
      resolve = done;
    });
    const pending = begin();
    await flush();
    iconWait = undefined;
    await begin("accessibility");
    resolve();
    await pending;
    expect(get()!.kind).toBe("accessibility");
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
    await begin();
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
  });

  test("a replaced guide cannot drag a stale application", async () => {
    await begin();
    const previous = get()!;
    const previousWindow = windows.get("permission-guide")!;
    await begin("accessibility");
    expect(previousWindow.destroyed).toBe(true);
    expect(get()!.appName).toBe("Vellum");
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
});
