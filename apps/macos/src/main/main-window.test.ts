import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type StubWebContents = {
  on: ReturnType<typeof mock>;
  once: (event: string, handler: () => void) => void;
  emit: (event: string) => void;
  send: ReturnType<typeof mock>;
};
type StubWindow = {
  show: ReturnType<typeof mock>;
  hide: ReturnType<typeof mock>;
  focus: ReturnType<typeof mock>;
  restore: ReturnType<typeof mock>;
  loadURL: ReturnType<typeof mock>;
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  isVisible: () => boolean;
  isFocused: () => boolean;
  on: ReturnType<typeof mock>;
  once: (event: string, handler: () => void) => StubWindow;
  webContents: StubWebContents;
  // Test seam — emits a `closed` event so the production code's
  // module-scope `mainWindow = null` cleanup runs.
  emit: (event: string) => void;
};

type WindowState = {
  destroyed: boolean;
  minimized: boolean;
  visible: boolean;
  focused: boolean;
};

let constructed: Array<{ stub: StubWindow; state: WindowState }> = [];
let listeners: Map<string, Array<() => void>>;

const makeWindow = (): StubWindow => {
  const state: WindowState = {
    destroyed: false,
    minimized: false,
    visible: false,
    focused: false,
  };
  listeners = new Map();
  const stub: StubWindow = {
    show: mock(() => {
      state.visible = true;
    }),
    hide: mock(() => {
      state.visible = false;
      state.focused = false;
    }),
    focus: mock(() => {
      state.focused = true;
    }),
    restore: mock(() => {
      state.minimized = false;
    }),
    loadURL: mock(() => Promise.resolve()),
    isDestroyed: () => state.destroyed,
    isMinimized: () => state.minimized,
    isVisible: () => state.visible,
    isFocused: () => state.focused,
    on: mock((event: string, handler: () => void) => {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
      return stub;
    }),
    once: (event, handler) => {
      const arr = listeners.get(event) ?? [];
      arr.push(handler);
      listeners.set(event, arr);
      return stub;
    },
    webContents: ((): StubWebContents => {
      const wcListeners = new Map<string, Array<() => void>>();
      const wc: StubWebContents = {
        on: mock(() => undefined),
        once: (event, handler) => {
          const arr = wcListeners.get(event) ?? [];
          arr.push(handler);
          wcListeners.set(event, arr);
        },
        emit: (event) => {
          for (const h of wcListeners.get(event) ?? []) h();
        },
        send: mock(() => undefined),
      };
      return wc;
    })(),
    emit: (event) => {
      if (event === "closed") state.destroyed = true;
      for (const h of listeners.get(event) ?? []) h();
    },
  };
  constructed.push({ stub, state });
  return stub;
};

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
const ipcHandleMock = mock(
  (channel: string, handler: (...args: unknown[]) => unknown) => {
    ipcHandlers.set(channel, handler);
  },
);

mock.module("electron", () => ({
  app: {
    isPackaged: false,
  },
  BrowserWindow: class {
    constructor(_opts: unknown) {
      Object.assign(this, makeWindow());
    }
  },
  ipcMain: { handle: ipcHandleMock },
  shell: { openExternal: () => Promise.resolve() },
}));

mock.module("./window-state", () => ({
  restoreBounds: () => ({ width: 1280, height: 800 }),
  track: () => undefined,
}));

const { __resetForTesting, current, dispatchToMain, ensureVisible, hide, installMainWindow, isVisibleAndFocused, toggleVisibility } =
  await import("./main-window");
const { resolveAllowedOrigin } = await import("./app-origin");

// The IPC wrapper rejects any sender whose frame origin isn't the
// app renderer's, so the handler must be invoked with a frame at the
// allowed origin. Deriving it from the guard's own resolver keeps the
// fake sender correct without hard-coding the dev or packaged origin.
const { protocol: allowedProtocol, host: allowedHost } = resolveAllowedOrigin();
const allowedEvent = { senderFrame: { origin: `${allowedProtocol}//${allowedHost}` } };

const reset = (): void => {
  // Force a fresh module-scope window between tests by emitting `closed`
  // on whatever's currently alive. The production code listens for
  // `closed` and nulls its `mainWindow` reference.
  for (const { stub, state } of constructed) {
    if (!state.destroyed) stub.emit("closed");
  }
  constructed = [];
};

beforeEach(() => {
  reset();
  __resetForTesting();
  ipcHandlers.clear();
  ipcHandleMock.mockClear();
});

afterEach(() => {
  reset();
});

describe("ensureVisible", () => {
  test("creates a new BrowserWindow when none exists", () => {
    ensureVisible();
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.stub.loadURL).toHaveBeenCalledTimes(1);
  });

  test("recreates after the previous window was destroyed", () => {
    ensureVisible();
    constructed[0]?.stub.emit("closed");
    ensureVisible();
    expect(constructed).toHaveLength(2);
  });

  test("restores from minimize, then shows + focuses", () => {
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");
    win.state.minimized = true;
    win.state.visible = false;
    win.state.focused = false;

    ensureVisible();
    expect(win.stub.restore).toHaveBeenCalledTimes(1);
    expect(win.stub.show).toHaveBeenCalled();
    expect(win.stub.focus).toHaveBeenCalled();
    expect(constructed).toHaveLength(1);
  });

  test("shows + focuses an already-existing window without recreating", () => {
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");
    win.state.visible = false;
    win.state.focused = false;

    ensureVisible();
    expect(constructed).toHaveLength(1);
    expect(win.stub.show).toHaveBeenCalled();
    expect(win.stub.focus).toHaveBeenCalled();
  });
});

describe("hide", () => {
  test("hides a visible window", () => {
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");

    hide();
    expect(win.stub.hide).toHaveBeenCalledTimes(1);
    expect(win.state.visible).toBe(false);
  });

  test("is a no-op when no window exists", () => {
    hide();
    // No window to act on, no construction triggered.
    expect(constructed).toHaveLength(0);
  });

  test("is a no-op when the window was destroyed", () => {
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");
    win.stub.emit("closed");

    const hideCallsBefore = win.stub.hide.mock.calls.length;
    hide();
    expect(win.stub.hide.mock.calls.length).toBe(hideCallsBefore);
  });
});

describe("toggleVisibility", () => {
  test("hides when visible and focused", () => {
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");
    win.state.visible = true;
    win.state.focused = true;

    toggleVisibility();
    expect(win.stub.hide).toHaveBeenCalledTimes(1);
  });

  test("ensures visible when hidden", () => {
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");
    win.state.visible = false;
    win.state.focused = false;
    const showsBefore = win.stub.show.mock.calls.length;

    toggleVisibility();
    expect(win.stub.show.mock.calls.length).toBe(showsBefore + 1);
  });

  test("recreates when destroyed", () => {
    ensureVisible();
    constructed[0]?.stub.emit("closed");

    toggleVisibility();
    expect(constructed).toHaveLength(2);
  });
});

describe("isVisibleAndFocused", () => {
  test("false when no window exists", () => {
    expect(isVisibleAndFocused()).toBe(false);
  });

  test("true only when visible AND focused", () => {
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");
    win.state.visible = true;
    win.state.focused = false;
    expect(isVisibleAndFocused()).toBe(false);

    win.state.focused = true;
    expect(isVisibleAndFocused()).toBe(true);
  });
});

describe("ensureVisible readiness gate", () => {
  test("the returned promise waits for BOTH did-finish-load AND ready-to-show", async () => {
    let resolved = false;
    const promise = ensureVisible().then(() => {
      resolved = true;
    });
    const win = constructed[0];
    if (!win) throw new Error("expected a window");

    // Only `did-finish-load` fired — promise should still be pending.
    win.stub.webContents.emit("did-finish-load");
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Now `ready-to-show` fires, gating the resolution.
    win.stub.emit("ready-to-show");
    await promise;
    expect(resolved).toBe(true);
  });

  test("resolves regardless of which event arrives first", async () => {
    let resolved = false;
    const promise = ensureVisible().then(() => {
      resolved = true;
    });
    const win = constructed[0];
    if (!win) throw new Error("expected a window");

    win.stub.emit("ready-to-show");
    await Promise.resolve();
    expect(resolved).toBe(false);

    win.stub.webContents.emit("did-finish-load");
    await promise;
    expect(resolved).toBe(true);
  });

  test("a second ensureVisible against an in-flight window waits on the same readiness", async () => {
    let firstResolved = false;
    let secondResolved = false;
    void ensureVisible().then(() => {
      firstResolved = true;
    });
    void ensureVisible().then(() => {
      secondResolved = true;
    });
    // Same window was used for both calls — no new construction.
    expect(constructed).toHaveLength(1);
    const win = constructed[0];
    if (!win) throw new Error("expected a window");

    await Promise.resolve();
    expect(firstResolved).toBe(false);
    expect(secondResolved).toBe(false);

    win.stub.webContents.emit("did-finish-load");
    win.stub.emit("ready-to-show");
    // Yield to flush microtasks.
    await Promise.resolve();
    await Promise.resolve();
    expect(firstResolved).toBe(true);
    expect(secondResolved).toBe(true);
  });

  test("unblocks the awaiter if the window is destroyed before either event fires", async () => {
    let resolved = false;
    const promise = ensureVisible().then(() => {
      resolved = true;
    });
    const win = constructed[0];
    if (!win) throw new Error("expected a window");

    // Simulate the destroyed-before-ready race (network failure during
    // load, user quit mid-load). Neither did-finish-load nor
    // ready-to-show ever fire.
    win.stub.emit("closed");
    await promise;
    expect(resolved).toBe(true);
  });

  test("ready-to-show shows AND focuses the window so dispatchToFocused targets it", () => {
    void ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");

    win.stub.emit("ready-to-show");
    expect(win.stub.show).toHaveBeenCalled();
    expect(win.stub.focus).toHaveBeenCalled();
  });
});

describe("installMainWindow", () => {
  test("creates the initial window on first call, no-op on subsequent calls", () => {
    installMainWindow();
    installMainWindow();
    installMainWindow();
    expect(constructed).toHaveLength(1);
  });

  test("registers the vellum:mainWindow:ensureVisible IPC handler", () => {
    installMainWindow();
    expect(ipcHandlers.has("vellum:mainWindow:ensureVisible")).toBe(true);
  });

  test("the IPC handler routes through ensureVisible (recreating if destroyed, showing + focusing otherwise)", async () => {
    installMainWindow();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");
    // The initial install fires ensureVisible too — settle its readiness
    // gate before exercising the IPC path so the assertion isolates the
    // IPC-driven calls.
    win.stub.webContents.emit("did-finish-load");
    win.stub.emit("ready-to-show");
    const showsBefore = win.stub.show.mock.calls.length;
    const focusBefore = win.stub.focus.mock.calls.length;

    const handler = ipcHandlers.get("vellum:mainWindow:ensureVisible");
    const promise = (handler as (event: unknown) => Promise<void>)(allowedEvent);
    // ensureVisible on the existing-but-not-focused window returns
    // immediately (ALREADY_READY for the already-loaded window).
    await promise;

    expect(win.stub.show.mock.calls.length).toBeGreaterThan(showsBefore);
    expect(win.stub.focus.mock.calls.length).toBeGreaterThan(focusBefore);
  });
});

describe("dispatchToMain", () => {
  test("sends `vellum:command` to the main window's webContents", () => {
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");

    dispatchToMain({ kind: "newConversation" });

    expect(win.stub.webContents.send).toHaveBeenCalledWith(
      "vellum:command",
      { kind: "newConversation" },
    );
  });

  test("no-ops when no main window exists", () => {
    dispatchToMain({ kind: "newConversation" });
    expect(constructed).toHaveLength(0);
  });

  test("no-ops when the main window has been destroyed", () => {
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");
    win.stub.emit("closed");

    const before = win.stub.webContents.send.mock.calls.length;
    dispatchToMain({ kind: "newConversation" });
    expect(win.stub.webContents.send.mock.calls.length).toBe(before);
  });
});

describe("current", () => {
  test("returns null before any window has been created", () => {
    expect(current()).toBeNull();
  });

  test("returns the live window reference after ensureVisible", () => {
    ensureVisible();
    expect(current()).not.toBeNull();
  });

  test("returns null again after the window is destroyed", () => {
    ensureVisible();
    constructed[0]?.stub.emit("closed");
    expect(current()).toBeNull();
  });
});
