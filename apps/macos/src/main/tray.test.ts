import { describe, expect, mock, test } from "bun:test";

// Capture every Tray instance constructed during a test run so we can
// assert on calls and on idempotency. The constructor proxies records
// into module scope; `installTray` itself is `installed`-gated, so
// across the whole test file we expect exactly one construction.
type TrayCall = { event: string; handler: (...args: unknown[]) => void };
type StubTray = {
  setIgnoreDoubleClickEvents: ReturnType<typeof mock>;
  setToolTip: ReturnType<typeof mock>;
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

const buildFromTemplateMock = mock((_template: unknown) => ({
  popup: () => undefined,
}));

const setTemplateImageMock = mock((_flag: boolean) => undefined);
const createFromBitmapMock = mock((_buf: unknown, _opts: unknown) => ({
  setTemplateImage: setTemplateImageMock,
}));

mock.module("electron", () => ({
  app: {
    name: "Vellum Electron",
  },
  // `./commands` imports `BrowserWindow` at the top level for
  // `dispatchToFocused` — provide a stub so the import resolves even
  // though our tests don't exercise that code path.
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
  nativeImage: {
    createFromBitmap: createFromBitmapMock,
  },
}));

// Mock `./settings` so importing `./commands` (which `tray.ts` imports
// transitively for `resolveAccelerator`) doesn't try to construct an
// electron-store instance in the test environment.
mock.module("./settings", () => ({
  readSetting: () => null,
}));

const { installTray } = await import("./tray");

describe("installTray", () => {
  const handlers = {
    toggleMainWindow: mock(() => undefined),
    openAbout: mock(() => undefined),
  };

  test("constructs the Tray, ignores double-clicks, sets a tooltip, registers click and right-click — all on the first call only", () => {
    installTray(handlers);
    installTray(handlers);
    installTray(handlers);

    expect(trays).toHaveLength(1);
    const tray = trays[0];
    expect(tray).toBeDefined();
    expect(tray?.setIgnoreDoubleClickEvents).toHaveBeenCalledTimes(1);
    expect(tray?.setIgnoreDoubleClickEvents.mock.calls[0]?.[0]).toBe(true);
    expect(tray?.setToolTip).toHaveBeenCalledTimes(1);

    const eventNames = tray?.events.map((e) => e.event) ?? [];
    expect(eventNames).toContain("click");
    expect(eventNames).toContain("right-click");
  });

  test("uses a template image so macOS can auto-invert for dark mode", () => {
    expect(setTemplateImageMock).toHaveBeenCalled();
    expect(setTemplateImageMock.mock.calls[0]?.[0]).toBe(true);
  });

  test("left-click routes through the toggleMainWindow handler", () => {
    const tray = trays[0];
    const clickHandler = tray?.events.find((e) => e.event === "click")?.handler;
    expect(clickHandler).toBeDefined();
    const before = handlers.toggleMainWindow.mock.calls.length;
    clickHandler?.();
    expect(handlers.toggleMainWindow.mock.calls.length).toBe(before + 1);
  });

  test("right-click pops the context menu", () => {
    const tray = trays[0];
    const rightClickHandler = tray?.events.find(
      (e) => e.event === "right-click",
    )?.handler;
    expect(rightClickHandler).toBeDefined();
    const before = tray?.popUpContextMenu.mock.calls.length ?? 0;
    rightClickHandler?.();
    expect(tray?.popUpContextMenu.mock.calls.length).toBe(before + 1);
  });

  test("builds a menu containing the canonical tray actions", () => {
    expect(buildFromTemplateMock).toHaveBeenCalledTimes(1);
    const template = buildFromTemplateMock.mock.calls[0]?.[0] as Array<{
      label?: string;
      role?: string;
      type?: string;
    }>;
    const labels = template.map((item) => item.label).filter(Boolean);
    expect(labels).toContain("New Conversation");
    expect(labels).toContain("Current Conversation");
    expect(labels).toContain("Show / Hide Main Window");
    expect(labels).toContain("About Vellum Electron");
    expect(labels).toContain("Quit Vellum Electron");

    const quitItem = template.find((item) => item.label?.startsWith("Quit"));
    expect(quitItem?.role).toBe("quit");
  });
});
