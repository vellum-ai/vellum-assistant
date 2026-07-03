import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Tray stub: records constructions, event listeners, and image swaps.
type TrayCall = { event: string; handler: (...args: unknown[]) => void };
type StubTray = {
  setIgnoreDoubleClickEvents: ReturnType<typeof mock>;
  setToolTip: ReturnType<typeof mock>;
  setImage: ReturnType<typeof mock>;
  on: (event: string, handler: (...args: unknown[]) => void) => StubTray;
  popUpContextMenu: ReturnType<typeof mock>;
  destroy: ReturnType<typeof mock>;
  events: TrayCall[];
};

const trays: StubTray[] = [];

const makeTray = (): StubTray => {
  const events: TrayCall[] = [];
  const stub: StubTray = {
    setIgnoreDoubleClickEvents: mock(() => undefined),
    setToolTip: mock(() => undefined),
    setImage: mock(() => undefined),
    on: (event, handler) => {
      events.push({ event, handler });
      return stub;
    },
    popUpContextMenu: mock(() => undefined),
    destroy: mock(() => undefined),
    events,
  };
  return stub;
};

const handlerFor = (stub: StubTray | undefined, event: string) =>
  stub?.events.find((e) => e.event === event)?.handler;

const buildFromTemplateMock = mock((_template: unknown) => ({
  popup: () => undefined,
}));

// Capture app lifecycle listeners (e.g. before-quit) so cleanup is testable.
const appListeners = new Map<string, () => void>();
// Capture nativeTheme listeners so the appearance-change path is testable.
const themeListeners = new Map<string, () => void>();

const appRelaunchMock = mock(() => undefined);
const appQuitMock = mock(() => undefined);

mock.module("electron", () => ({
  app: {
    name: "Vellum Electron",
    on: (event: string, handler: () => void) => {
      appListeners.set(event, handler);
    },
    relaunch: appRelaunchMock,
    quit: appQuitMock,
  },
  BrowserWindow: class {
    static getFocusedWindow() {
      return null;
    }
    static getAllWindows() {
      return [];
    }
  },
  Menu: {
    buildFromTemplate: buildFromTemplateMock,
  },
  Tray: class {
    constructor(_icon: unknown) {
      const stub = makeTray();
      trays.push(stub);
      Object.assign(this, stub);
    }
  },
  nativeTheme: {
    on: (event: string, handler: () => void) => {
      themeListeners.set(event, handler);
    },
    removeListener: (event: string) => {
      themeListeners.delete(event);
    },
  },
  shell: {
    openExternal: mock(() => Promise.resolve()),
  },
}));

mock.module("./assets/menu-icons", () => ({
  MENU_ICON_MESSAGESQUARE: { png1x: "", png2x: "" },
  MENU_ICON_MESSAGECIRCLEPLUS: { png1x: "", png2x: "" },
  MENU_ICON_CIRCLECHECK: { png1x: "", png2x: "" },
  MENU_ICON_SETTINGS: { png1x: "", png2x: "" },
  MENU_ICON_MESSAGECIRCLE: { png1x: "", png2x: "" },
  MENU_ICON_REFRESHCW: { png1x: "", png2x: "" },
  MENU_ICON_POWER: { png1x: "", png2x: "" },
}));

mock.module("./menu-icon", () => ({
  menuIcon: () => ({ __kind: "template-icon" }),
}));

mock.module("./lockfile-watcher", () => ({
  getWatchedLockfile: () => ({ assistants: [], activeAssistant: null }),
}));

// Full `./settings` surface so this mock — which leaks into co-run test files
// via the global module registry — doesn't break sibling modules that import
// `writeSetting`/`onSettingChange` (e.g. `hotkeys.ts`).
mock.module("./settings", () => ({
  readSetting: () => null,
  readHotkeyOverride: () => null,
  writeSetting: () => {},
  onSettingChange: () => () => {},
}));

mock.module("./window-state", () => ({
  readOnboardingActive: () => false,
}));

const dispatchToMainMock = mock((_command: unknown) => undefined);
mock.module("./main-window", () => ({
  dispatchToMain: dispatchToMainMock,
}));

// Stub the icon module so the tray test stays free of real `nativeImage`
// rendering. Frames are plain sentinels; `thinking` yields a multi-frame
// array so the pulse path is exercised, every other state a single frame.
const THINKING_FRAMES = [{ id: "thinking-0" }, { id: "thinking-1" }];
const statusFramesMock = mock((status: string) =>
  status === "thinking" ? THINKING_FRAMES : [{ id: status }],
);
const invalidateIconCacheMock = mock(() => undefined);
mock.module("./status-icon", () => ({
  statusFrames: statusFramesMock,
  invalidateIconCache: invalidateIconCacheMock,
}));

// A controllable in-memory avatar-change publisher standing in for `./avatar`.
const avatarListeners = new Set<() => void>();
const publishAvatarChange = () => {
  for (const listener of avatarListeners) listener();
};
mock.module("./avatar", () => ({
  onAvatarChange: (listener: () => void) => {
    avatarListeners.add(listener);
    return () => avatarListeners.delete(listener);
  },
}));

// A controllable in-memory status state machine standing in for `./status`.
let currentStatus = "idle";
const statusListeners = new Set<(status: string) => void>();
const setStatus = (status: string) => {
  if (status === currentStatus) return;
  currentStatus = status;
  for (const listener of statusListeners) listener(status);
};
mock.module("./status", () => ({
  getStatus: () => currentStatus,
  onStatusChange: (listener: (status: string) => void) => {
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
  },
  statusMenuTitle: (status: string) => `title:${status}`,
  shouldPulse: (status: string) => status === "thinking",
  PULSE_FRAME_INTERVAL_MS: 80,
}));

// Mock the identity module so `tray.ts`'s import of it doesn't pull in the
// real `./ipc` → `electron` chain (the electron mock above omits `ipcMain`).
// Mirrors the `./status` mock: the tray reads the name for its tooltip/header
// and subscribes for live updates.
mock.module("./identity", () => ({
  getName: () => null,
  onNameChange: () => () => undefined,
}));

const { installTray, __resetForTesting } = await import("./tray");

const handlers = {
  toggleMainWindow: mock(() => undefined),
  ensureMainWindow: mock(() => Promise.resolve()),
  openAbout: mock(() => undefined),
};

// Swap in fake timers so the pulse loop and deferred restart are deterministic.
let intervalCallback: (() => void) | null = null;
const clearIntervalMock = mock((_id: unknown) => undefined);
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
const originalSetTimeout = globalThis.setTimeout;
let timeoutCallbacks: (() => void)[] = [];

beforeEach(() => {
  __resetForTesting();
  trays.length = 0;
  appListeners.clear();
  themeListeners.clear();
  avatarListeners.clear();
  buildFromTemplateMock.mockClear();
  statusFramesMock.mockClear();
  invalidateIconCacheMock.mockClear();
  appRelaunchMock.mockClear();
  appQuitMock.mockClear();
  currentStatus = "idle";
  statusListeners.clear();
  intervalCallback = null;
  clearIntervalMock.mockClear();
  globalThis.setInterval = ((cb: () => void) => {
    intervalCallback = cb;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = clearIntervalMock as unknown as typeof clearInterval;
  timeoutCallbacks = [];
  globalThis.setTimeout = ((cb: () => void) => {
    timeoutCallbacks.push(cb);
    return 2 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
});

afterEach(() => {
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  globalThis.setTimeout = originalSetTimeout;
});

describe("installTray", () => {
  test("constructs the Tray once and wires click + right-click, idempotently", () => {
    installTray(handlers);
    installTray(handlers);

    expect(trays).toHaveLength(1);
    const tray = trays[0];
    expect(tray?.setIgnoreDoubleClickEvents).toHaveBeenCalledTimes(1);
    expect(handlerFor(tray, "click")).toBeDefined();
    expect(handlerFor(tray, "right-click")).toBeDefined();
  });

  test("seeds the icon and tooltip from the current status", () => {
    installTray(handlers);
    const tray = trays[0];
    // Constructed with the idle frame; tooltip reflects the idle title.
    expect(statusFramesMock).toHaveBeenCalledWith("idle");
    expect(tray?.setToolTip).toHaveBeenLastCalledWith("title:idle");
  });

  test("left-click routes through the toggleMainWindow handler", () => {
    installTray(handlers);
    const before = handlers.toggleMainWindow.mock.calls.length;
    handlerFor(trays[0], "click")?.();
    expect(handlers.toggleMainWindow.mock.calls.length).toBe(before + 1);
  });

  test("right-click pops the context menu", () => {
    installTray(handlers);
    const tray = trays[0];
    const before = tray?.popUpContextMenu.mock.calls.length ?? 0;
    handlerFor(tray, "right-click")?.();
    expect(tray?.popUpContextMenu.mock.calls.length).toBe(before + 1);
  });

  test("the menu, built on right-click, leads with a disabled status header and the canonical actions", () => {
    installTray(handlers);
    handlerFor(trays[0], "right-click")?.();
    const template = buildFromTemplateMock.mock.calls[0]?.[0] as Array<{
      label?: string;
      role?: string;
      enabled?: boolean;
    }>;
    expect(template[0]?.label).toBe("title:idle");
    expect(template[0]?.enabled).toBe(false);

    const labels = template.map((item) => item.label).filter(Boolean);
    expect(labels).toContain("New Conversation");
    expect(labels).toContain("Current Conversation");
    expect(labels).toContain("Mark All as Read");
    expect(labels).toContain("Show / Hide Main Window");
    expect(labels).toContain("Restart");
    expect(labels).toContain("About Vellum Electron");
    expect(labels).toContain("Quit Vellum Electron");
    expect(
      template.find((item) => item.label?.startsWith("Quit"))?.role,
    ).toBe("quit");
  });

  test("the Re-pair item appears only when status is authFailed", () => {
    setStatus("authFailed");
    installTray(handlers);
    handlerFor(trays[0], "right-click")?.();
    const template = buildFromTemplateMock.mock.calls[0]?.[0] as Array<{
      label?: string;
    }>;
    const labels = template.map((item) => item.label).filter(Boolean);
    expect(labels).toContain("Re-pair Assistant");
  });

  test("the Re-pair item is absent when status is not authFailed", () => {
    installTray(handlers);
    handlerFor(trays[0], "right-click")?.();
    const template = buildFromTemplateMock.mock.calls[0]?.[0] as Array<{
      label?: string;
    }>;
    const labels = template.map((item) => item.label).filter(Boolean);
    expect(labels).not.toContain("Re-pair Assistant");
  });

  test("Re-pair surfaces the window and dispatches rePair command", async () => {
    setStatus("authFailed");
    installTray(handlers);
    handlerFor(trays[0], "right-click")?.();
    const template = buildFromTemplateMock.mock.calls[0]?.[0] as Array<{
      label?: string;
      click?: () => void | Promise<void>;
    }>;
    const beforeEnsure = handlers.ensureMainWindow.mock.calls.length;
    const beforeDispatch = dispatchToMainMock.mock.calls.length;

    await template.find((i) => i.label === "Re-pair Assistant")?.click?.();

    expect(handlers.ensureMainWindow.mock.calls.length).toBe(beforeEnsure + 1);
    expect(dispatchToMainMock.mock.calls[beforeDispatch]?.[0]).toEqual({
      kind: "rePair",
    });
  });

  test("Mark All as Read surfaces the window and dispatches markAllRead command", async () => {
    installTray(handlers);
    handlerFor(trays[0], "right-click")?.();
    const template = buildFromTemplateMock.mock.calls[0]?.[0] as Array<{
      label?: string;
      click?: () => void | Promise<void>;
    }>;
    const beforeEnsure = handlers.ensureMainWindow.mock.calls.length;
    const beforeDispatch = dispatchToMainMock.mock.calls.length;

    await template.find((i) => i.label === "Mark All as Read")?.click?.();

    expect(handlers.ensureMainWindow.mock.calls.length).toBe(beforeEnsure + 1);
    expect(dispatchToMainMock.mock.calls[beforeDispatch]?.[0]).toEqual({
      kind: "markAllRead",
    });
  });

  test("Restart relaunches the app and exits", () => {
    installTray(handlers);
    handlerFor(trays[0], "right-click")?.();
    const template = buildFromTemplateMock.mock.calls[0]?.[0] as Array<{
      label?: string;
      click?: () => void;
    }>;

    template.find((i) => i.label === "Restart")?.click?.();

    // The restart is deferred via setTimeout so it runs after the
    // NSMenu tracking loop unwinds. Flush the captured callback.
    expect(timeoutCallbacks).toHaveLength(1);
    timeoutCallbacks[0]!();

    expect(appRelaunchMock).toHaveBeenCalledTimes(1);
    expect(appQuitMock).toHaveBeenCalledTimes(1);
  });

  test("conversation items surface the window before dispatching", async () => {
    installTray(handlers);
    handlerFor(trays[0], "right-click")?.();
    const template = buildFromTemplateMock.mock.calls[0]?.[0] as Array<{
      label?: string;
      click?: () => void | Promise<void>;
    }>;
    const beforeEnsure = handlers.ensureMainWindow.mock.calls.length;
    const beforeDispatch = dispatchToMainMock.mock.calls.length;

    await template.find((i) => i.label === "New Conversation")?.click?.();

    expect(handlers.ensureMainWindow.mock.calls.length).toBe(beforeEnsure + 1);
    expect(dispatchToMainMock.mock.calls[beforeDispatch]?.[0]).toEqual({
      kind: "newConversation",
    });
  });
});

describe("status-driven updates", () => {
  test("a status change swaps the icon and tooltip", () => {
    installTray(handlers);
    const tray = trays[0];
    tray?.setImage.mockClear();

    setStatus("disconnected");

    expect(statusFramesMock).toHaveBeenLastCalledWith("disconnected");
    expect(tray?.setImage).toHaveBeenLastCalledWith({ id: "disconnected" });
    expect(tray?.setToolTip).toHaveBeenLastCalledWith("title:disconnected");
  });

  test("the menu is built lazily at pop time, not rebuilt on every status tick", () => {
    installTray(handlers);
    // No menu is constructed until the user actually right-clicks.
    expect(buildFromTemplateMock).not.toHaveBeenCalled();

    setStatus("thinking");
    setStatus("idle");
    setStatus("error");
    expect(buildFromTemplateMock).not.toHaveBeenCalled();

    // A single right-click listener survives every tick, and the menu it
    // builds reflects the status current at pop time.
    const tray = trays[0];
    expect(tray?.events.filter((e) => e.event === "right-click")).toHaveLength(
      1,
    );
    handlerFor(tray, "right-click")?.();
    expect(buildFromTemplateMock).toHaveBeenCalledTimes(1);
    const menu = buildFromTemplateMock.mock.calls[0]?.[0] as Array<{
      label?: string;
    }>;
    expect(menu[0]?.label).toBe("title:error");
  });

  test("thinking starts the pulse and cycles frames; leaving it stops the pulse", () => {
    installTray(handlers);
    const tray = trays[0];

    setStatus("thinking");
    tray?.setImage.mockClear();
    expect(intervalCallback).not.toBeNull();

    intervalCallback?.();
    expect(tray?.setImage).toHaveBeenLastCalledWith(THINKING_FRAMES[1]);
    intervalCallback?.();
    expect(tray?.setImage).toHaveBeenLastCalledWith(THINKING_FRAMES[0]);

    const clearedBefore = clearIntervalMock.mock.calls.length;
    setStatus("idle");
    expect(clearIntervalMock.mock.calls.length).toBe(clearedBefore + 1);
  });

  test("before-quit stops the pulse, removes the theme listener, and destroys the tray", () => {
    installTray(handlers);
    setStatus("thinking");
    const tray = trays[0];

    appListeners.get("before-quit")?.();

    expect(clearIntervalMock).toHaveBeenCalled();
    expect(themeListeners.has("updated")).toBe(false);
    expect(tray?.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("avatar and appearance updates", () => {
  test("an avatar change invalidates the icon cache and reapplies the current status", () => {
    installTray(handlers);
    setStatus("error");
    const tray = trays[0];
    tray?.setImage.mockClear();
    invalidateIconCacheMock.mockClear();

    publishAvatarChange();

    expect(invalidateIconCacheMock).toHaveBeenCalledTimes(1);
    expect(tray?.setImage).toHaveBeenLastCalledWith({ id: "error" });
  });

  test("a system appearance change invalidates the icon cache and reapplies the current status", () => {
    installTray(handlers);
    const tray = trays[0];
    tray?.setImage.mockClear();
    invalidateIconCacheMock.mockClear();

    themeListeners.get("updated")?.();

    expect(invalidateIconCacheMock).toHaveBeenCalledTimes(1);
    expect(tray?.setImage).toHaveBeenLastCalledWith({ id: "idle" });
  });
});
