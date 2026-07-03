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
  setTitle: ReturnType<typeof mock>;
  isDestroyed: () => boolean;
  isMinimized: () => boolean;
  isVisible: () => boolean;
  isFocused: () => boolean;
  on: ReturnType<typeof mock>;
  once: (event: string, handler: () => void) => StubWindow;
  isResizable: () => boolean;
  setResizable: ReturnType<typeof mock>;
  setMaximizable: ReturnType<typeof mock>;
  setFullScreenable: ReturnType<typeof mock>;
  setContentSize: ReturnType<typeof mock>;
  setMinimumSize: ReturnType<typeof mock>;
  setBounds: ReturnType<typeof mock>;
  setPosition: ReturnType<typeof mock>;
  setFullScreen: ReturnType<typeof mock>;
  isFullScreen: () => boolean;
  center: ReturnType<typeof mock>;
  setWindowButtonPosition: ReturnType<typeof mock>;
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
  resizable: boolean;
  fullscreen: boolean;
};

let constructed: Array<{
  stub: StubWindow;
  state: WindowState;
  opts: Record<string, unknown>;
}> = [];

// Controls what the mocked `readOnboardingActive()` returns when the
// next window is constructed. Toggled by tests that exercise the
// onboarding (small/fixed) vs. main (resizable) creation branches.
let onboardingActive = false;
const writeOnboardingActiveMock = mock((active: boolean) => {
  onboardingActive = active;
});
let listeners: Map<string, Array<() => void>>;

const makeWindow = (opts: Record<string, unknown> = {}): StubWindow => {
  const state: WindowState = {
    destroyed: false,
    minimized: false,
    visible: false,
    focused: false,
    // Mirrors the BrowserWindow default (resizable) unless the
    // constructor opts opt out, as the onboarding branch does.
    resizable: opts.resizable !== false,
    // Mirrors the BrowserWindow default (windowed) unless the constructor
    // opts in, as the fresh-install fullscreen default does.
    fullscreen: opts.fullscreen === true,
  };
  listeners = new Map();
  const stub: StubWindow = {
    isResizable: () => state.resizable,
    setResizable: mock((value: boolean) => {
      state.resizable = value;
    }),
    setMaximizable: mock(() => undefined),
    setFullScreenable: mock(() => undefined),
    setContentSize: mock(() => undefined),
    setMinimumSize: mock(() => undefined),
    setBounds: mock(() => undefined),
    setPosition: mock(() => undefined),
    setFullScreen: mock((value: boolean) => {
      state.fullscreen = value;
    }),
    isFullScreen: () => state.fullscreen,
    center: mock(() => undefined),
    setWindowButtonPosition: mock(() => undefined),
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
    setTitle: mock(() => undefined),
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
  constructed.push({ stub, state, opts });
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
    constructor(opts: Record<string, unknown>) {
      Object.assign(this, makeWindow(opts));
    }
  },
  ipcMain: { handle: ipcHandleMock },
  shell: { openExternal: () => Promise.resolve() },
}));

// What the mocked `restoreBounds()` returns. Defaults to a saved windowed
// state; tests exercising the fresh-install maximized default or a saved
// fullscreen session override it.
let restoredBounds: {
  x?: number;
  y?: number;
  width: number;
  height: number;
  fullscreen?: boolean;
} = {
  width: 1280,
  height: 800,
};

mock.module("./window-state", () => ({
  restoreBounds: () => restoredBounds,
  track: () => undefined,
  readOnboardingActive: () => onboardingActive,
  writeOnboardingActive: writeOnboardingActiveMock,
}));

const { __resetForTesting, current, dispatchToMain, ensureVisible, hide, installMainWindow, isVisibleAndFocused, setOnboarding, toggleVisibility } =
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
  onboardingActive = false;
  writeOnboardingActiveMock.mockClear();
  restoredBounds = { width: 1280, height: 800 };
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

describe("onboarding window sizing", () => {
  test("creates a 440×660 default-size but still resizable window when onboarding is active", () => {
    onboardingActive = true;
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");
    expect(win.opts.width).toBe(440);
    expect(win.opts.height).toBe(660);
    expect(win.opts.useContentSize).toBe(true);
    // The 440×660 default is also the floor, so the chrome-less flow can't
    // be dragged below its content.
    expect(win.opts.minWidth).toBe(440);
    expect(win.opts.minHeight).toBe(660);
    // Onboarding is the default size only — the window stays resizable
    // (no `resizable: false` opt), so it inherits the Electron default.
    expect(win.opts.resizable).toBeUndefined();
    expect(win.stub.isResizable()).toBe(true);
  });

  test("creates a resizable restored-bounds window when onboarding is inactive", () => {
    onboardingActive = false;
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");
    expect(win.opts.width).toBe(1280);
    expect(win.opts.height).toBe(800);
    expect(win.opts.useContentSize).toBeUndefined();
    // The main app carries the 800×600 floor (mirrors Swift `MainWindow`).
    expect(win.opts.minWidth).toBe(800);
    expect(win.opts.minHeight).toBe(600);
    expect(win.opts.resizable).toBeUndefined();
    expect(win.stub.isResizable()).toBe(true);
    // A saved windowed state stays windowed — never upgraded to fullscreen.
    expect(win.opts.fullscreen).toBeUndefined();
  });

  test("setOnboarding(true) shrinks an existing main window to the default", () => {
    onboardingActive = false;
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");

    setOnboarding(true);

    expect(writeOnboardingActiveMock).toHaveBeenCalledWith(true);
    expect(win.stub.setContentSize).toHaveBeenCalledWith(440, 660);
    // Entering onboarding clamps the minimum to the compact content size.
    expect(win.stub.setMinimumSize).toHaveBeenCalledWith(440, 660);
    expect(win.stub.center).toHaveBeenCalled();
    // The window stays resizable across the transition — never locked.
    expect(win.stub.setResizable).not.toHaveBeenCalled();
  });

  test("setOnboarding(false) grows an existing onboarding window to the main bounds", () => {
    onboardingActive = true;
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");

    setOnboarding(false);

    expect(writeOnboardingActiveMock).toHaveBeenCalledWith(false);
    expect(win.stub.setBounds).toHaveBeenCalledWith({ width: 1280, height: 800 });
    // Leaving onboarding swaps the compact floor for the 800×600 main floor.
    expect(win.stub.setMinimumSize).toHaveBeenCalledWith(800, 600);
    expect(win.stub.setResizable).not.toHaveBeenCalled();
  });

  test("re-asserting the current mode persists but does not resize the window", () => {
    onboardingActive = false;
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");

    setOnboarding(false);

    expect(writeOnboardingActiveMock).toHaveBeenCalledWith(false);
    expect(win.stub.setContentSize).not.toHaveBeenCalled();
    expect(win.stub.setBounds).not.toHaveBeenCalled();
    // No transition → the minimum-size floor is left untouched.
    expect(win.stub.setMinimumSize).not.toHaveBeenCalled();
  });

  test("persists the mode even when no window exists yet", () => {
    setOnboarding(true);
    expect(writeOnboardingActiveMock).toHaveBeenCalledWith(true);
    expect(constructed).toHaveLength(0);
  });

  test("installMainWindow registers the setOnboarding IPC handler routing through setOnboarding", async () => {
    installMainWindow();
    expect(ipcHandlers.has("vellum:mainWindow:setOnboarding")).toBe(true);
    const win = constructed[0];
    if (!win) throw new Error("expected a window");

    const handler = ipcHandlers.get("vellum:mainWindow:setOnboarding");
    await (handler as (event: unknown, active: boolean) => Promise<void>)(
      allowedEvent,
      true,
    );

    expect(writeOnboardingActiveMock).toHaveBeenCalledWith(true);
    expect(win.stub.setContentSize).toHaveBeenCalledWith(440, 660);
  });

  test("centres the macOS traffic lights for a main-app window on creation", () => {
    onboardingActive = false;
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");

    // Inline title-bar layout: cluster centred in the ~44px header.
    expect(win.stub.setWindowButtonPosition).toHaveBeenCalledWith({ x: 19, y: 15 });
  });

  test("keeps the system-default traffic lights for a compact onboarding window", () => {
    onboardingActive = true;
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");

    // Compact / pre-app surfaces have no inline title bar → reset to default.
    expect(win.stub.setWindowButtonPosition).toHaveBeenCalledWith(null);
  });

  test("setOnboarding(true) resets the traffic lights to the system default", () => {
    onboardingActive = false;
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");
    win.stub.setWindowButtonPosition.mockClear();

    setOnboarding(true);

    expect(win.stub.setWindowButtonPosition).toHaveBeenCalledWith(null);
  });

  test("setOnboarding(false) re-centres the traffic lights for the main app", () => {
    onboardingActive = true;
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");
    win.stub.setWindowButtonPosition.mockClear();

    setOnboarding(false);

    expect(win.stub.setWindowButtonPosition).toHaveBeenCalledWith({ x: 19, y: 15 });
  });

  test("re-asserting the current mode does not reposition the traffic lights", () => {
    onboardingActive = false;
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");
    win.stub.setWindowButtonPosition.mockClear();

    setOnboarding(false);

    expect(win.stub.setWindowButtonPosition).not.toHaveBeenCalled();
  });
});

describe("maximized default", () => {
  test("constructs the main window at the restored work-area bounds (fresh-install default)", () => {
    restoredBounds = { x: 0, y: 25, width: 1512, height: 944 };
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");
    expect(win.opts.x).toBe(0);
    expect(win.opts.y).toBe(25);
    expect(win.opts.width).toBe(1512);
    expect(win.opts.height).toBe(944);
    // Maximized means work-area bounds — a normal window, never native
    // fullscreen.
    expect(win.opts.fullscreen).toBeUndefined();
  });

  test("setOnboarding(false) applies the work-area bounds without entering fullscreen", () => {
    onboardingActive = true;
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");
    restoredBounds = { x: 0, y: 25, width: 1512, height: 944 };

    setOnboarding(false);

    expect(win.stub.setBounds).toHaveBeenCalledWith({ width: 1512, height: 944 });
    expect(win.stub.setPosition).toHaveBeenCalledWith(0, 25);
    expect(win.stub.setFullScreen).not.toHaveBeenCalled();
  });
});

describe("fullscreen session restore", () => {
  test("constructs the main window fullscreen when the saved session was fullscreen", () => {
    restoredBounds = { width: 1280, height: 800, fullscreen: true };
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");
    expect(win.opts.fullscreen).toBe(true);
  });

  test("never constructs the compact onboarding window fullscreen", () => {
    restoredBounds = { width: 1280, height: 800, fullscreen: true };
    onboardingActive = true;
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");
    expect(win.opts.fullscreen).toBeUndefined();
  });

  test("setOnboarding(true) on a fullscreen window leaves fullscreen and defers the shrink", () => {
    restoredBounds = { width: 1280, height: 800, fullscreen: true };
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");
    expect(win.stub.isFullScreen()).toBe(true);

    setOnboarding(true);

    expect(win.stub.setFullScreen).toHaveBeenCalledWith(false);
    // Geometry changes are ignored mid-transition, so nothing is applied
    // until `leave-full-screen` lands.
    expect(win.stub.setContentSize).not.toHaveBeenCalled();
    expect(win.stub.setMinimumSize).not.toHaveBeenCalled();

    win.stub.emit("leave-full-screen");
    expect(win.stub.setMinimumSize).toHaveBeenCalledWith(440, 660);
    expect(win.stub.setContentSize).toHaveBeenCalledWith(440, 660);
    expect(win.stub.center).toHaveBeenCalled();
  });

  test("drops the deferred shrink when the mode flips back to main before leave-full-screen lands", () => {
    restoredBounds = { width: 1280, height: 800, fullscreen: true };
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");

    setOnboarding(true);
    setOnboarding(false);
    win.stub.setContentSize.mockClear();

    win.stub.emit("leave-full-screen");
    expect(win.stub.setContentSize).not.toHaveBeenCalled();
  });

  test("setOnboarding(false) re-enters fullscreen when the restored state calls for it", () => {
    onboardingActive = true;
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");
    restoredBounds = { width: 1280, height: 800, fullscreen: true };

    setOnboarding(false);

    // Windowed geometry is applied first — it's the rectangle the user
    // lands on when exiting fullscreen.
    expect(win.stub.setBounds).toHaveBeenCalledWith({ width: 1280, height: 800 });
    expect(win.stub.setFullScreen).toHaveBeenCalledWith(true);
  });

  test("setOnboarding(false) stays windowed when the restored state is windowed", () => {
    onboardingActive = true;
    ensureVisible();
    const win = constructed[0];
    if (!win) throw new Error("expected a window");

    setOnboarding(false);

    expect(win.stub.setFullScreen).not.toHaveBeenCalled();
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
