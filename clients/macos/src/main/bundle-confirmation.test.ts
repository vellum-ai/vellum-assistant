import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { BundleScanData } from "./bundle-manager";

type StubWebContents = {
  on: (event: string, listener: (...args: unknown[]) => void) => StubWebContents;
  setWindowOpenHandler: (
    handler: (details: { url: string }) => { action: "deny" | "allow" },
  ) => void;
  events: Map<string, Array<(...args: unknown[]) => void>>;
};

type StubWindow = {
  show: () => void;
  focus: () => void;
  close: () => void;
  isDestroyed: () => boolean;
  on: (event: string, listener: () => void) => StubWindow;
  once: (event: string, listener: () => void) => StubWindow;
  loadURL: (url: string) => Promise<void>;
  webContents: StubWebContents;
  emit: (event: string) => void;
};

let constructed: StubWindow[] = [];
const showMock = mock(() => undefined);
const focusMock = mock(() => undefined);
const loadURLMock = mock((_url: string) => Promise.resolve());

const makeWindow = (): StubWindow => {
  const listeners = new Map<string, Array<() => void>>();
  const webContentsListeners = new Map<
    string,
    Array<(...args: unknown[]) => void>
  >();
  let destroyed = false;
  const webContents: StubWebContents = {
    on: (event, listener) => {
      const arr = webContentsListeners.get(event) ?? [];
      arr.push(listener);
      webContentsListeners.set(event, arr);
      return webContents;
    },
    setWindowOpenHandler: () => undefined,
    events: webContentsListeners,
  };
  const win: StubWindow = {
    show: showMock,
    focus: focusMock,
    close() {
      win.emit("closed");
    },
    isDestroyed: () => destroyed,
    on: (event, listener) => {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return win;
    },
    once: (event, listener) => {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return win;
    },
    loadURL: loadURLMock,
    webContents,
    emit: (event) => {
      if (event === "closed") destroyed = true;
      for (const l of listeners.get(event) ?? []) l();
    },
  };
  return win;
};

const ipcHandleMock = mock((_channel: string, _handler: unknown) => undefined);
const ipcOnMock = mock((_channel: string, _handler: unknown) => undefined);

mock.module("electron", () => ({
  app: {
    isPackaged: false,
  },
  BrowserWindow: class {
    constructor() {
      const win = makeWindow();
      constructed.push(win);
      Object.assign(this, win);
    }
  },
  ipcMain: {
    handle: ipcHandleMock,
    on: ipcOnMock,
  },
}));

const { openBundleConfirmation, installBundleConfirmation } = await import(
  "./bundle-confirmation"
);

const SAMPLE_DATA: BundleScanData = {
  manifest: {
    format_version: 1,
    name: "Test Bundle",
    description: "A test bundle",
    icon: "🧪",
    entry: "index.html",
    capabilities: ["network"],
    created_by: "user@example.com",
    created_at: "2025-01-01T00:00:00Z",
  },
  scanResult: {
    passed: true,
    blocked: [],
    warnings: [],
  },
  signatureResult: {
    trustTier: "signed",
    signerDisplayName: "Example User",
  },
  bundleSizeBytes: 12345,
};

beforeEach(() => {
  constructed = [];
  showMock.mockClear();
  focusMock.mockClear();
  loadURLMock.mockClear();
  ipcHandleMock.mockClear();
  ipcOnMock.mockClear();
});

afterEach(() => {
  for (const win of constructed) {
    if (!win.isDestroyed()) win.emit("closed");
  }
});

describe("openBundleConfirmation", () => {
  test("creates a window with the confirmation route URL", () => {
    void openBundleConfirmation(SAMPLE_DATA);
    expect(constructed).toHaveLength(1);
    expect(loadURLMock).toHaveBeenCalledTimes(1);
    expect(loadURLMock.mock.calls[0]?.[0]).toMatch(/\/bundle\/confirm$/);
  });

  test("closing the window resolves with false", async () => {
    const promise = openBundleConfirmation(SAMPLE_DATA);
    constructed[0]?.emit("closed");
    expect(await promise).toBe(false);
  });

  test("focuses existing window instead of creating a second one", async () => {
    const p1 = openBundleConfirmation(SAMPLE_DATA);
    const p2 = openBundleConfirmation(SAMPLE_DATA);

    expect(constructed).toHaveLength(1);
    expect(showMock).toHaveBeenCalled();
    expect(focusMock).toHaveBeenCalledTimes(1);
    expect(await p2).toBe(false);

    constructed[0]?.emit("closed");
    await p1;
  });

  test("reconstructs after the previous window was closed", () => {
    void openBundleConfirmation(SAMPLE_DATA);
    constructed[0]?.emit("closed");
    void openBundleConfirmation(SAMPLE_DATA);
    expect(constructed).toHaveLength(2);
  });

  test("blocks top-level navigation and popups", () => {
    void openBundleConfirmation(SAMPLE_DATA);
    const win = constructed[0];
    expect(win).toBeDefined();

    const willNavigateHandlers = win?.webContents.events.get("will-navigate");
    expect(willNavigateHandlers?.length).toBe(1);
    const preventDefault = mock(() => undefined);
    willNavigateHandlers?.[0]?.({ preventDefault });
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });
});

describe("installBundleConfirmation", () => {
  test("registers getData (handle) and respond (on) IPC channels", () => {
    installBundleConfirmation();

    const handleChannels = ipcHandleMock.mock.calls.map((c) => c[0]);
    expect(handleChannels).toContain("vellum:bundleConfirm:getData");

    const onChannels = ipcOnMock.mock.calls.map((c) => c[0]);
    expect(onChannels).toContain("vellum:bundleConfirm:respond");
  });
});
