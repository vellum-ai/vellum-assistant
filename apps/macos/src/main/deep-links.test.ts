import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Capture the `will-finish-launching` and `open-url` subscriptions
// from `app.on` so tests can fire them. `setAsDefaultProtocolClient`
// is also captured to verify scheme registration.
type Listener = (...args: unknown[]) => void;
const appListeners = new Map<string, Listener>();
const appOnMock = mock((event: string, listener: Listener) => {
  appListeners.set(event, listener);
});
const setAsDefaultProtocolClientMock = mock((_scheme: string) => true);
const ipcHandleMock = mock(
  (_channel: string, _handler: (...args: unknown[]) => unknown) => undefined,
);
let windows: Array<{
  isDestroyed: () => boolean;
  webContents: { send: ReturnType<typeof mock> };
}> = [];

mock.module("electron", () => ({
  app: {
    on: appOnMock,
    setAsDefaultProtocolClient: setAsDefaultProtocolClientMock,
  },
  ipcMain: { handle: ipcHandleMock },
  BrowserWindow: { getAllWindows: () => windows },
}));

const {
  __resetForTesting,
  extractDeepLinkFromArgv,
  handleDeepLink,
  installDeepLinks,
  parseVellumUrl,
} = await import("./deep-links");

const makeWindow = (destroyed = false) => ({
  isDestroyed: () => destroyed,
  webContents: { send: mock(() => undefined) },
});

beforeEach(() => {
  __resetForTesting();
  appListeners.clear();
  appOnMock.mockClear();
  setAsDefaultProtocolClientMock.mockClear();
  ipcHandleMock.mockClear();
  windows = [];
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
  test("registers both schemes with Launch Services and is idempotent across repeated calls", () => {
    installDeepLinks();
    installDeepLinks();
    installDeepLinks();

    const schemes = setAsDefaultProtocolClientMock.mock.calls.map((c) => c[0]);
    expect(schemes).toContain("vellum");
    expect(schemes).toContain("vellum-assistant");
    // 2 schemes × 1 install = 2 calls total (idempotent).
    expect(setAsDefaultProtocolClientMock).toHaveBeenCalledTimes(2);
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
    const drainHandler = drainCall![1] as () => unknown;

    expect(drainHandler()).toEqual([
      { kind: "send", message: "one" },
      { kind: "openThread", threadId: "abc" },
    ]);
    // Second drain returns empty — buffer was cleared.
    expect(drainHandler()).toEqual([]);
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
