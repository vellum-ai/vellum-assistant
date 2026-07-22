import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

type Listener = (...args: unknown[]) => void;

const makeSender = (): {
  sender: { once: (event: string, handler: () => void) => void };
  fireDestroyed: () => void;
} => {
  let destroyedHandler: (() => void) | null = null;
  return {
    sender: {
      once: (event, handler) => {
        if (event === "destroyed") destroyedHandler = handler;
      },
    },
    fireDestroyed: () => destroyedHandler?.(),
  };
};

const subscribeWith = (s: ReturnType<typeof makeSender>) =>
  ipcOnListeners
    .get("vellum:fileOpen:subscribe")
    ?.({ sender: s.sender, senderFrame: allowedSenderFrame });
const unsubscribeWith = (s: ReturnType<typeof makeSender>) =>
  ipcOnListeners
    .get("vellum:fileOpen:unsubscribe")
    ?.({ sender: s.sender, senderFrame: allowedSenderFrame });

const appListeners = new Map<string, Listener>();
const appOnMock = mock((event: string, listener: Listener) => {
  appListeners.set(event, listener);
});
const ipcHandleMock = mock(
  (_channel: string, _handler: (...args: unknown[]) => unknown) => undefined,
);
const ipcOnListeners = new Map<string, Listener>();
const ipcOnMock = mock((event: string, listener: Listener) => {
  ipcOnListeners.set(event, listener);
});
let windows: Array<{
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof mock> };
}> = [];

let appIsReady = true;
mock.module("electron", () => ({
  app: {
    on: appOnMock,
    isReady: () => appIsReady,
  },
  ipcMain: { handle: ipcHandleMock, on: ipcOnMock },
  BrowserWindow: { getAllWindows: () => windows },
}));

const ensureMainWindowVisibleMock = mock(async () => undefined);
mock.module("./main-window", () => ({
  ensureVisible: ensureMainWindowVisibleMock,
}));

const {
  __resetForTesting,
  handleFileOpen,
  installFileOpen,
  onFileOpen,
} = await import("./file-open");
const { resolveAllowedOrigin } = await import("./app-origin");

const { protocol: allowedProtocol, host: allowedHost } = resolveAllowedOrigin();
const allowedSenderFrame = { origin: `${allowedProtocol}//${allowedHost}` };
const makeAllowedEvent = () => {
  const { sender, fireDestroyed } = makeSender();
  return {
    event: { senderFrame: allowedSenderFrame, sender },
    fireDestroyed,
  };
};
const allowedEvent = makeAllowedEvent().event;

const makeWindow = (destroyed = false) => ({
  isDestroyed: () => destroyed,
  webContents: { send: mock(() => undefined) },
});

beforeEach(() => {
  __resetForTesting();
  appListeners.clear();
  ipcOnListeners.clear();
  appOnMock.mockClear();
  ipcHandleMock.mockClear();
  ipcOnMock.mockClear();
  ensureMainWindowVisibleMock.mockClear();
  windows = [];
  appIsReady = true;
});

afterEach(() => {
  windows = [];
});

describe("handleFileOpen", () => {
  test(".vellum files are buffered when no subscribers exist", () => {
    installFileOpen();

    handleFileOpen("/tmp/example.vellum");

    const drainHandler = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "vellum:fileOpen:drain",
    )![1] as (event: unknown) => unknown[];
    expect(drainHandler(allowedEvent)).toEqual(["/tmp/example.vellum"]);
  });

  test("non-.vellum files are silently ignored", () => {
    installFileOpen();

    handleFileOpen("/tmp/example.txt");
    handleFileOpen("/tmp/example.vellum.bak");
    handleFileOpen("/tmp/readme.md");

    const drainHandler = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "vellum:fileOpen:drain",
    )![1] as (event: unknown) => unknown[];
    expect(drainHandler(allowedEvent)).toEqual([]);
  });

  test(".VELLUM extension is accepted (case-insensitive)", () => {
    installFileOpen();

    handleFileOpen("/tmp/example.VELLUM");

    const drainHandler = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "vellum:fileOpen:drain",
    )![1] as (event: unknown) => unknown[];
    expect(drainHandler(allowedEvent)).toEqual(["/tmp/example.VELLUM"]);
  });

  test("calls ensureMainWindowVisible when app is ready", () => {
    handleFileOpen("/tmp/example.vellum");
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("defers activation when app is not yet ready", () => {
    appIsReady = false;
    handleFileOpen("/tmp/example.vellum");
    expect(ensureMainWindowVisibleMock).not.toHaveBeenCalled();
  });
});

describe("drain", () => {
  test("returns buffered paths and clears buffer", () => {
    installFileOpen();

    handleFileOpen("/tmp/a.vellum");
    handleFileOpen("/tmp/b.vellum");

    const drainHandler = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "vellum:fileOpen:drain",
    )![1] as (event: unknown) => unknown[];

    expect(drainHandler(allowedEvent)).toEqual([
      "/tmp/a.vellum",
      "/tmp/b.vellum",
    ]);
    // Second drain returns empty.
    expect(drainHandler(allowedEvent)).toEqual([]);
  });

  test("drain adds the sender to subscribers", () => {
    installFileOpen();

    handleFileOpen("/tmp/backlog.vellum");

    const drainHandler = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "vellum:fileOpen:drain",
    )![1] as (event: unknown) => unknown[];
    drainHandler(allowedEvent);

    // With a subscriber, the next file should NOT enter the buffer.
    handleFileOpen("/tmp/live.vellum");
    expect(drainHandler(allowedEvent)).toEqual([]);
  });
});

describe("broadcast", () => {
  test("fires event to all non-destroyed windows", () => {
    const w1 = makeWindow();
    const w2 = makeWindow();
    windows = [w1, w2];

    handleFileOpen("/tmp/example.vellum");

    expect(w1.webContents.send).toHaveBeenCalledWith(
      "vellum:fileOpen:event",
      "/tmp/example.vellum",
    );
    expect(w2.webContents.send).toHaveBeenCalledWith(
      "vellum:fileOpen:event",
      "/tmp/example.vellum",
    );
  });

  test("skips destroyed windows", () => {
    const alive = makeWindow();
    const dead = makeWindow(true);
    windows = [alive, dead];

    handleFileOpen("/tmp/example.vellum");

    expect(alive.webContents.send).toHaveBeenCalled();
    expect(dead.webContents.send).not.toHaveBeenCalled();
  });
});

describe("subscriber lifecycle", () => {
  test("with a subscriber present, live files broadcast but do NOT enter the buffer", () => {
    installFileOpen();
    const drainHandler = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "vellum:fileOpen:drain",
    )![1] as (event: unknown) => unknown[];

    handleFileOpen("/tmp/backlog.vellum");

    const s1 = makeSender();
    subscribeWith(s1);
    expect(drainHandler(allowedEvent)).toEqual(["/tmp/backlog.vellum"]);

    handleFileOpen("/tmp/live.vellum");

    unsubscribeWith(s1);
    const s2 = makeSender();
    subscribeWith(s2);
    expect(drainHandler(allowedEvent)).toEqual([]);
  });

  test("file arriving while unsubscribed lands in the buffer for the next subscriber", () => {
    installFileOpen();
    const drainHandler = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "vellum:fileOpen:drain",
    )![1] as (event: unknown) => unknown[];

    // Drain with a fresh event (also subscribes the drain sender).
    const d1 = makeAllowedEvent();
    expect(drainHandler(d1.event)).toEqual([]);

    // Simulate the drain sender going away so subscribers empties.
    d1.fireDestroyed();
    handleFileOpen("/tmp/post-logout.vellum");

    // New drain picks up the buffered path.
    expect(drainHandler(makeAllowedEvent().event)).toEqual([
      "/tmp/post-logout.vellum",
    ]);
  });

  test("destroyed webContents auto-clears its subscription", () => {
    installFileOpen();
    const drainHandler = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "vellum:fileOpen:drain",
    )![1] as (event: unknown) => unknown[];

    // Drain subscribes its sender; verify the buffer is empty.
    const d = makeAllowedEvent();
    expect(drainHandler(d.event)).toEqual([]);

    // Simulate the drain sender being destroyed (auto-clears).
    d.fireDestroyed();

    handleFileOpen("/tmp/after-crash.vellum");
    expect(drainHandler(makeAllowedEvent().event)).toEqual([
      "/tmp/after-crash.vellum",
    ]);
  });
});

describe("installFileOpen", () => {
  test("is idempotent", () => {
    installFileOpen();
    installFileOpen();
    installFileOpen();

    // will-finish-launching registered only once.
    const wflCalls = appOnMock.mock.calls.filter(
      (c) => c[0] === "will-finish-launching",
    );
    expect(wflCalls.length).toBe(1);
  });

  test("subscribes to will-finish-launching and registers an open-file listener under it", () => {
    installFileOpen();
    const wfl = appListeners.get("will-finish-launching");
    expect(wfl).toBeDefined();

    wfl?.();
    expect(appListeners.has("open-file")).toBe(true);
  });

  test("open-file calls preventDefault on the event and routes through handleFileOpen", () => {
    installFileOpen();
    appListeners.get("will-finish-launching")?.();
    const openFile = appListeners.get("open-file");
    expect(openFile).toBeDefined();

    const preventDefault = mock(() => undefined);
    openFile?.({ preventDefault } as unknown, "/tmp/example.vellum");

    expect(preventDefault).toHaveBeenCalled();
  });
});

describe("onFileOpen", () => {
  test("replays buffered paths to a newly registered callback", () => {
    handleFileOpen("/tmp/cold-launch.vellum");
    handleFileOpen("/tmp/cold-launch-2.vellum");

    const received: string[] = [];
    onFileOpen((p) => received.push(p));

    expect(received).toEqual([
      "/tmp/cold-launch.vellum",
      "/tmp/cold-launch-2.vellum",
    ]);
  });

  test("does not replay paths that were already drained", () => {
    installFileOpen();

    handleFileOpen("/tmp/early.vellum");

    const drainHandler = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "vellum:fileOpen:drain",
    )![1] as (event: unknown) => unknown[];
    drainHandler(allowedEvent);

    const received: string[] = [];
    onFileOpen((p) => received.push(p));

    expect(received).toEqual([]);
  });

  test("receives live file-open events after registration", () => {
    const received: string[] = [];
    onFileOpen((p) => received.push(p));

    handleFileOpen("/tmp/live.vellum");

    expect(received).toEqual(["/tmp/live.vellum"]);
  });

  test("unsubscribe stops receiving events", () => {
    const received: string[] = [];
    const unsub = onFileOpen((p) => received.push(p));

    unsub();
    handleFileOpen("/tmp/after-unsub.vellum");

    expect(received).toEqual([]);
  });
});
