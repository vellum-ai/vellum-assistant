import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Capture the `will-finish-launching` and `open-url` subscriptions
// from `app.on` so tests can fire them. `setAsDefaultProtocolClient`
// is also captured to verify scheme registration.
type Listener = (...args: unknown[]) => void;

// Synthetic WebContents stub for the subscriber-tracking tests.
// `once("destroyed", …)` captures the cleanup handler so tests can
// fire it to simulate a renderer crash / window close.
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
    .get("vellum:deepLinks:subscribe")
    ?.({ sender: s.sender, senderFrame: allowedSenderFrame });
const unsubscribeWith = (s: ReturnType<typeof makeSender>) =>
  ipcOnListeners
    .get("vellum:deepLinks:unsubscribe")
    ?.({ sender: s.sender, senderFrame: allowedSenderFrame });
const appListeners = new Map<string, Listener>();
const appOnMock = mock((event: string, listener: Listener) => {
  appListeners.set(event, listener);
});
const setAsDefaultProtocolClientMock = mock((_scheme: string) => true);
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
    setAsDefaultProtocolClient: setAsDefaultProtocolClientMock,
    isReady: () => appIsReady,
  },
  ipcMain: { handle: ipcHandleMock, on: ipcOnMock },
  BrowserWindow: { getAllWindows: () => windows },
}));

// `./main-window` is called from `handleDeepLink` to bring the main
// window forward for actionable kinds. Stub so we can assert on the
// call without standing up the full lifecycle module (which
// transitively imports electron-store).
const ensureMainWindowVisibleMock = mock(async () => undefined);
mock.module("./main-window", () => ({
  ensureVisible: ensureMainWindowVisibleMock,
}));

const {
  __resetForTesting,
  extractDeepLinkFromArgv,
  handleDeepLink,
  installDeepLinks,
  parseVellumUrl,
  resolveAcceptedSchemes,
  resolveRegisteredSchemes,
} = await import("./deep-links");
const { resolveAllowedOrigin } = await import("./app-origin");
const { resolveEnvironmentName } = await import("@vellumai/local-mode");

// The IPC wrappers reject any sender whose frame origin isn't the
// build's renderer origin. These tests drive the registered handlers
// directly, so they must present a frame at that origin; deriving it
// from the guard's own resolver keeps the fake sender correct without
// hard-coding either the dev or packaged origin here.
const { protocol: allowedProtocol, host: allowedHost } = resolveAllowedOrigin();
const allowedSenderFrame = { origin: `${allowedProtocol}//${allowedHost}` };
const allowedEvent = { senderFrame: allowedSenderFrame };

const makeWindow = (destroyed = false) => ({
  isDestroyed: () => destroyed,
  webContents: { send: mock(() => undefined) },
});

beforeEach(() => {
  __resetForTesting();
  appListeners.clear();
  ipcOnListeners.clear();
  appOnMock.mockClear();
  setAsDefaultProtocolClientMock.mockClear();
  ipcHandleMock.mockClear();
  ipcOnMock.mockClear();
  ensureMainWindowVisibleMock.mockClear();
  windows = [];
  appIsReady = true;
});

afterEach(() => {
  windows = [];
});

describe("parseVellumUrl", () => {
  test("vellum://send?message=hi → send with the message", () => {
    expect(parseVellumUrl("vellum://send?message=hi")).toEqual({
      kind: "send",
      message: "hi",
    });
  });

  test("vellum-assistant://send?message=hi → same shape under the alternate scheme", () => {
    expect(parseVellumUrl("vellum-assistant://send?message=hi")).toEqual({
      kind: "send",
      message: "hi",
    });
  });

  test("vellum://send → empty message (preserved, renderer decides)", () => {
    expect(parseVellumUrl("vellum://send")).toEqual({
      kind: "send",
      message: "",
    });
  });

  test("vellum://send decodes percent-encoded query parameters", () => {
    expect(parseVellumUrl("vellum://send?message=hello%20world")).toEqual({
      kind: "send",
      message: "hello world",
    });
  });

  test("vellum://thread/abc-123 → openThread with the id", () => {
    expect(parseVellumUrl("vellum://thread/abc-123")).toEqual({
      kind: "openThread",
      threadId: "abc-123",
    });
  });

  test("vellum://thread/abc-123/extra → openThread on first segment, extras ignored", () => {
    expect(parseVellumUrl("vellum://thread/abc-123/extra")).toEqual({
      kind: "openThread",
      threadId: "abc-123",
    });
  });

  test("vellum://thread → unknown (no id)", () => {
    expect(parseVellumUrl("vellum://thread")).toEqual({
      kind: "unknown",
      url: "vellum://thread",
    });
  });

  test("rejects foreign schemes — javascript: returns unknown", () => {
    expect(parseVellumUrl("javascript:alert(1)")).toEqual({
      kind: "unknown",
      url: "javascript:alert(1)",
    });
  });

  test("rejects file: scheme", () => {
    expect(parseVellumUrl("file:///etc/passwd")).toEqual({
      kind: "unknown",
      url: "file:///etc/passwd",
    });
  });

  test("rejects http: scheme", () => {
    expect(parseVellumUrl("http://vellum.ai/send")).toEqual({
      kind: "unknown",
      url: "http://vellum.ai/send",
    });
  });

  test("malformed input → unknown (catches URL constructor throws)", () => {
    expect(parseVellumUrl("not a url at all")).toEqual({
      kind: "unknown",
      url: "not a url at all",
    });
  });

  test("unrecognized vellum://… host → unknown", () => {
    expect(parseVellumUrl("vellum://garbage")).toEqual({
      kind: "unknown",
      url: "vellum://garbage",
    });
  });

  test("legacy auth/callback → unknown with query stripped (no code leak)", () => {
    // The legacy code must not survive into the URL the renderer logs as
    // a `deeplink.unknown` Sentry breadcrumb.
    expect(
      parseVellumUrl("vellum://auth/callback?code=secret&state=xyz"),
    ).toEqual({ kind: "unknown", url: "vellum://auth/callback" });
    expect(
      parseVellumUrl("vellum-assistant://auth/callback?code=secret"),
    ).toEqual({ kind: "unknown", url: "vellum-assistant://auth/callback" });
  });

  test("env-specific scheme for a foreign environment is rejected as unknown", () => {
    // A scheme that doesn't match any known environment is always
    // rejected, regardless of which env this test suite runs under.
    const url =
      "vellum-assistant-nonexistent://auth/callback?code=abc&state=xyz";
    expect(parseVellumUrl(url)).toEqual({ kind: "unknown", url });
  });
});

describe("extractDeepLinkFromArgv", () => {
  test("returns the first vellum:// URL in argv", () => {
    const argv = [
      "/usr/local/bin/electron",
      "--inspect=9229",
      "vellum://send?message=hi",
      "--unrelated",
    ];
    expect(extractDeepLinkFromArgv(argv)).toBe("vellum://send?message=hi");
  });

  test("matches the alternate scheme too", () => {
    expect(extractDeepLinkFromArgv(["vellum-assistant://thread/x"])).toBe(
      "vellum-assistant://thread/x",
    );
  });

  test("returns null when no deep-link arg is present", () => {
    expect(extractDeepLinkFromArgv(["/usr/local/bin/electron", "--foo"]))
      .toBeNull();
  });
});

describe("installDeepLinks", () => {
  test("registers only the env-appropriate schemes and is idempotent across repeated calls", () => {
    installDeepLinks();
    const firstCallCount = setAsDefaultProtocolClientMock.mock.calls.length;

    installDeepLinks();
    installDeepLinks();

    const schemes = setAsDefaultProtocolClientMock.mock.calls.map((c) => c[0]);
    const expected = resolveRegisteredSchemes(resolveEnvironmentName(process.env));
    expect(schemes).toEqual(expected);
    // Idempotent — repeated calls don't register again.
    expect(setAsDefaultProtocolClientMock).toHaveBeenCalledTimes(firstCallCount);
  });

  test("subscribes to will-finish-launching and registers an open-url listener under it", () => {
    installDeepLinks();
    const wfl = appListeners.get("will-finish-launching");
    expect(wfl).toBeDefined();

    wfl?.();
    expect(appListeners.has("open-url")).toBe(true);
  });

  test("open-url calls preventDefault on the event and buffers the parsed link", () => {
    installDeepLinks();
    appListeners.get("will-finish-launching")?.();
    const openUrl = appListeners.get("open-url");
    expect(openUrl).toBeDefined();

    const preventDefault = mock(() => undefined);
    openUrl?.({ preventDefault } as unknown, "vellum://send?message=hi");

    expect(preventDefault).toHaveBeenCalled();
  });

  test("registers the vellum:deepLinks:drain IPC handler returning + clearing the buffer", () => {
    installDeepLinks();

    handleDeepLink("vellum://send?message=one");
    handleDeepLink("vellum://thread/abc");

    // Find the registered handler.
    const drainCall = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "vellum:deepLinks:drain",
    );
    expect(drainCall).toBeDefined();
    const drainHandler = drainCall![1] as (event: unknown) => unknown;

    expect(drainHandler(allowedEvent)).toEqual([
      { kind: "send", message: "one" },
      { kind: "openThread", threadId: "abc" },
    ]);
    // Second drain returns empty — buffer was cleared.
    expect(drainHandler(allowedEvent)).toEqual([]);
  });

  test("with a subscriber present, live links broadcast but do NOT enter the buffer (no replay on renderer reload)", () => {
    installDeepLinks();
    const drainHandler = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "vellum:deepLinks:drain",
    )![1] as (event: unknown) => unknown[];

    // Backlog before any subscriber.
    handleDeepLink("vellum://send?message=backlog");

    // Renderer mounts: subscribes, drains.
    const s1 = makeSender();
    subscribeWith(s1);
    expect(drainHandler(allowedEvent)).toEqual([{ kind: "send", message: "backlog" }]);

    // Live link arrives while subscribed — broadcasts only.
    handleDeepLink("vellum://thread/live");

    // Renderer hard-navigates: unsubscribe, then a new renderer
    // mounts and drains. The live link must NOT be replayed.
    unsubscribeWith(s1);
    const s2 = makeSender();
    subscribeWith(s2);
    expect(drainHandler(allowedEvent)).toEqual([]);
  });

  test("logout-relogin: link arriving while unsubscribed lands in the buffer for the next subscriber", () => {
    installDeepLinks();
    const drainHandler = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "vellum:deepLinks:drain",
    )![1] as (event: unknown) => unknown[];

    const s1 = makeSender();
    subscribeWith(s1);
    expect(drainHandler(allowedEvent)).toEqual([]);

    unsubscribeWith(s1);

    handleDeepLink("vellum://thread/post-logout");

    const s2 = makeSender();
    subscribeWith(s2);
    expect(drainHandler(allowedEvent)).toEqual([
      { kind: "openThread", threadId: "post-logout" },
    ]);
  });

  test("unsubscribe with no matching subscriber is a no-op (idempotent delete)", () => {
    installDeepLinks();
    const drainHandler = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "vellum:deepLinks:drain",
    )![1] as (event: unknown) => unknown[];

    const s = makeSender();
    unsubscribeWith(s);
    unsubscribeWith(s);

    handleDeepLink("vellum://send?message=should-buffer");
    expect(drainHandler(allowedEvent)).toEqual([
      { kind: "send", message: "should-buffer" },
    ]);
  });

  test("post-drain live links still broadcast (live subscribers still get them)", () => {
    installDeepLinks();
    const s = makeSender();
    subscribeWith(s);

    const w = makeWindow();
    windows = [w];
    handleDeepLink("vellum://send?message=live");

    expect(w.webContents.send).toHaveBeenCalledWith("vellum:deepLinks:event", {
      kind: "send",
      message: "live",
    });
  });

  test("destroyed webContents auto-clears its subscription (no leak when React cleanup misses)", () => {
    // The real bug this guards against: window close on Darwin
    // can tear down the JS context before React effect cleanups
    // flush, so `vellum:deepLinks:unsubscribe` never fires.
    // The `destroyed` listener cleans up regardless, so future
    // links buffer correctly.
    installDeepLinks();
    const drainHandler = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "vellum:deepLinks:drain",
    )![1] as (event: unknown) => unknown[];

    const s = makeSender();
    subscribeWith(s);
    expect(drainHandler(allowedEvent)).toEqual([]);

    // Simulate window close without React cleanup running — only
    // the webContents `destroyed` event fires.
    s.fireDestroyed();

    // No subscribers now → next link is buffered.
    handleDeepLink("vellum://send?message=after-crash");
    expect(drainHandler(allowedEvent)).toEqual([
      { kind: "send", message: "after-crash" },
    ]);
  });
});

describe("handleDeepLink — broadcast", () => {
  test("broadcasts to every BrowserWindow's webContents", () => {
    const w1 = makeWindow();
    const w2 = makeWindow();
    windows = [w1, w2];

    handleDeepLink("vellum://send?message=broadcast");

    const expected = { kind: "send", message: "broadcast" };
    expect(w1.webContents.send).toHaveBeenCalledWith(
      "vellum:deepLinks:event",
      expected,
    );
    expect(w2.webContents.send).toHaveBeenCalledWith(
      "vellum:deepLinks:event",
      expected,
    );
  });

  test("skips destroyed windows", () => {
    const alive = makeWindow();
    const dead = makeWindow(true);
    windows = [alive, dead];

    handleDeepLink("vellum://send?message=skip");

    expect(alive.webContents.send).toHaveBeenCalled();
    expect(dead.webContents.send).not.toHaveBeenCalled();
  });

  test("unknown-kind links are still broadcast (renderer logs / drops)", () => {
    const w = makeWindow();
    windows = [w];

    handleDeepLink("javascript:alert(1)");

    expect(w.webContents.send).toHaveBeenCalledWith("vellum:deepLinks:event", {
      kind: "unknown",
      url: "javascript:alert(1)",
    });
  });
});

describe("handleDeepLink — window activation", () => {
  test("brings the main window forward for `send` (covers the no-renderer case on Darwin)", () => {
    handleDeepLink("vellum://send?message=hi");
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("brings the main window forward for `openThread`", () => {
    handleDeepLink("vellum://thread/abc");
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("does NOT activate the window for unknown kinds (no UI side effect for foreign schemes)", () => {
    handleDeepLink("javascript:alert(1)");
    handleDeepLink("file:///etc/passwd");
    handleDeepLink("not a url");

    expect(ensureMainWindowVisibleMock).not.toHaveBeenCalled();
  });

  test("defers activation when app is not yet ready (cold-launch via vellum://)", () => {
    // Cold launch path: `will-finish-launching` → `open-url` fires
    // BEFORE `app.whenReady()`. `new BrowserWindow()` pre-ready
    // would race Electron init; the link is buffered above and the
    // initial `installMainWindow` in the whenReady chain creates
    // the window which drains it on mount.
    appIsReady = false;
    handleDeepLink("vellum://send?message=cold-launch");

    expect(ensureMainWindowVisibleMock).not.toHaveBeenCalled();
  });

  test("activates after app becomes ready (warm path: subsequent links)", () => {
    appIsReady = false;
    handleDeepLink("vellum://send?message=cold");
    expect(ensureMainWindowVisibleMock).not.toHaveBeenCalled();

    // Simulate whenReady having fired.
    appIsReady = true;
    handleDeepLink("vellum://thread/warm");
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
  });

  test("buffers the link AND activates so the renderer-on-mount drain still delivers it", () => {
    // Simulating the macOS path: app alive, main window closed,
    // user clicks vellum://send → main handles it. The link must
    // both (a) be parked in the buffer for the freshly-created
    // renderer to drain, and (b) trigger window creation so the
    // renderer actually mounts.
    handleDeepLink("vellum://send?message=delivered");

    // Activation fired.
    expect(ensureMainWindowVisibleMock).toHaveBeenCalledTimes(1);
    // Link buffered (no subscribers yet — the new window hasn't
    // mounted).
    const drainHandler = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "vellum:deepLinks:drain",
    );
    // installDeepLinks hasn't run in this test, so register the
    // handler via a fresh install before draining.
    if (!drainHandler) {
      installDeepLinks();
    }
    const drain = ipcHandleMock.mock.calls.find(
      (c) => c[0] === "vellum:deepLinks:drain",
    )![1] as (event: unknown) => unknown[];
    expect(drain(allowedEvent)).toEqual([
      { kind: "send", message: "delivered" },
    ]);
  });
});

describe("resolveRegisteredSchemes", () => {
  test("production registers vellum and vellum-assistant", () => {
    expect(resolveRegisteredSchemes("production")).toEqual([
      "vellum",
      "vellum-assistant",
    ]);
  });

  test("dev registers only vellum-assistant-dev", () => {
    expect(resolveRegisteredSchemes("dev")).toEqual(["vellum-assistant-dev"]);
  });

  test("staging registers only vellum-assistant-staging", () => {
    expect(resolveRegisteredSchemes("staging")).toEqual([
      "vellum-assistant-staging",
    ]);
  });

  test("local registers only vellum-assistant-local", () => {
    expect(resolveRegisteredSchemes("local")).toEqual([
      "vellum-assistant-local",
    ]);
  });

  test("unknown env derives scheme from env name", () => {
    expect(resolveRegisteredSchemes("test")).toEqual(["vellum-assistant-test"]);
  });
});

describe("resolveAcceptedSchemes", () => {
  test("production accepts vellum: and vellum-assistant:", () => {
    const accepted = resolveAcceptedSchemes("production");
    expect(accepted).toContain("vellum:");
    expect(accepted).toContain("vellum-assistant:");
    expect(accepted).toHaveLength(2);
  });

  test("dev accepts vellum:, vellum-assistant:, and vellum-assistant-dev:", () => {
    const accepted = resolveAcceptedSchemes("dev");
    expect(accepted).toContain("vellum:");
    expect(accepted).toContain("vellum-assistant:");
    expect(accepted).toContain("vellum-assistant-dev:");
    expect(accepted).toHaveLength(3);
  });

  test("staging accepts vellum:, vellum-assistant:, and vellum-assistant-staging:", () => {
    const accepted = resolveAcceptedSchemes("staging");
    expect(accepted).toContain("vellum:");
    expect(accepted).toContain("vellum-assistant:");
    expect(accepted).toContain("vellum-assistant-staging:");
    expect(accepted).toHaveLength(3);
  });

  test("local accepts vellum:, vellum-assistant:, and vellum-assistant-local:", () => {
    const accepted = resolveAcceptedSchemes("local");
    expect(accepted).toContain("vellum:");
    expect(accepted).toContain("vellum-assistant:");
    expect(accepted).toContain("vellum-assistant-local:");
    expect(accepted).toHaveLength(3);
  });
});
