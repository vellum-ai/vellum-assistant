import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Tray stub: records constructions, event listeners, image swaps, and
// supports the `removeAllListeners` the status-driven rebuild relies on.
type TrayCall = { event: string; handler: (...args: unknown[]) => void };
type StubTray = {
  setIgnoreDoubleClickEvents: ReturnType<typeof mock>;
  setToolTip: ReturnType<typeof mock>;
  setImage: ReturnType<typeof mock>;
  on: (event: string, handler: (...args: unknown[]) => void) => StubTray;
  removeAllListeners: (event: string) => StubTray;
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
    removeAllListeners: (event) => {
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i]?.event === event) events.splice(i, 1);
      }
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

mock.module("electron", () => ({
  app: {
    name: "Vellum Electron",
    on: (event: string, handler: () => void) => {
      appListeners.set(event, handler);
    },
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
}));

mock.module("./settings", () => ({
  readSetting: () => null,
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
mock.module("./status-icon", () => ({
  statusFrames: statusFramesMock,
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

const { installTray, __resetForTesting } = await import("./tray");

const handlers = {
  toggleMainWindow: mock(() => undefined),
  ensureMainWindow: mock(() => Promise.resolve()),
  openAbout: mock(() => undefined),
};

// Swap in fake interval timers so the pulse loop is deterministic.
let intervalCallback: (() => void) | null = null;
const clearIntervalMock = mock((_id: unknown) => undefined);
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;

beforeEach(() => {
  __resetForTesting();
  trays.length = 0;
  appListeners.clear();
  buildFromTemplateMock.mockClear();
  statusFramesMock.mockClear();
  currentStatus = "idle";
  statusListeners.clear();
  intervalCallback = null;
  clearIntervalMock.mockClear();
  globalThis.setInterval = ((cb: () => void) => {
    intervalCallback = cb;
    return 1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = clearIntervalMock as unknown as typeof clearInterval;
});

afterEach(() => {
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
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

  test("the menu leads with a disabled status header and the canonical actions", () => {
    installTray(handlers);
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
    expect(labels).toContain("Show / Hide Main Window");
    expect(labels).toContain("About Vellum Electron");
    expect(labels).toContain("Quit Vellum Electron");
    expect(
      template.find((item) => item.label?.startsWith("Quit"))?.role,
    ).toBe("quit");
  });

  test("conversation items surface the window before dispatching", async () => {
    installTray(handlers);
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
  test("a status change swaps the icon, tooltip, and status header", () => {
    installTray(handlers);
    const tray = trays[0];
    tray?.setImage.mockClear();

    setStatus("disconnected");

    expect(statusFramesMock).toHaveBeenLastCalledWith("disconnected");
    expect(tray?.setImage).toHaveBeenLastCalledWith({ id: "disconnected" });
    expect(tray?.setToolTip).toHaveBeenLastCalledWith("title:disconnected");
    const latestMenu = buildFromTemplateMock.mock.calls.at(-1)?.[0] as Array<{
      label?: string;
    }>;
    expect(latestMenu[0]?.label).toBe("title:disconnected");
  });

  test("right-click after a status change pops the rebuilt menu", () => {
    installTray(handlers);
    const tray = trays[0];
    setStatus("error");
    // Exactly one right-click listener survives the rebuild.
    expect(tray?.events.filter((e) => e.event === "right-click")).toHaveLength(
      1,
    );
    const before = tray?.popUpContextMenu.mock.calls.length ?? 0;
    handlerFor(tray, "right-click")?.();
    expect(tray?.popUpContextMenu.mock.calls.length).toBe(before + 1);
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

  test("before-quit stops the pulse and destroys the tray", () => {
    installTray(handlers);
    setStatus("thinking");
    const tray = trays[0];

    appListeners.get("before-quit")?.();

    expect(clearIntervalMock).toHaveBeenCalled();
    expect(tray?.destroy).toHaveBeenCalledTimes(1);
  });
});
