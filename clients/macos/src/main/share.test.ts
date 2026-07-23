import { beforeEach, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";

import type { z } from "zod";

// Capture the invocable IPC registration `installShare` makes so the tests can
// drive the handler directly without a real `ipcMain`. The sender-origin guard
// inside the real `handle` is covered by `ipc.test.ts`, so it's intentionally
// absent here (mirrors `dock.test.ts`).
type Handler = (args: unknown[], event: unknown) => unknown;
type Registration = {
  channel: string;
  schema: z.ZodType<unknown[]>;
  fn: Handler;
};
const handleRegistrations: Registration[] = [];
mock.module("./ipc", () => ({
  handle: (channel: string, schema: z.ZodType<unknown[]>, fn: Handler) => {
    handleRegistrations.push({ channel, schema, fn });
  },
}));

// `node:fs/promises` is mocked so the temp-file dance and the sweep are
// asserted structurally — no real disk access. `node:os` / `node:path` stay
// real (pure helpers), so the asserted paths match what production builds.
const mkdtempMock = mock((prefix: string) =>
  Promise.resolve(`${prefix}abc123`),
);
const writeFileMock = mock((_path: string, _data: unknown) =>
  Promise.resolve(),
);
const readdirMock = mock((_path: string) => Promise.resolve<string[]>([]));
const rmMock = mock((_path: string, _opts: unknown) => Promise.resolve());
mock.module("node:fs/promises", () => ({
  mkdtemp: mkdtempMock,
  writeFile: writeFileMock,
  readdir: readdirMock,
  rm: rmMock,
}));

// Mock the electron seams `share.ts` touches: `app.on` (to register the
// before-quit cleanup), the `ShareMenu` picker, and `BrowserWindow` (used to
// anchor the sheet to the calling window). `ShareMenu` records its constructor
// arg + `popup` options so the tests can assert the file path and that no
// teardown callback is wired to menu close.
type PopupOpts = { window?: unknown; callback?: () => void };
const shareMenuArgs: Array<{ filePaths: string[] }> = [];
const popupCalls: PopupOpts[] = [];
class ShareMenuMock {
  constructor(arg: { filePaths: string[] }) {
    shareMenuArgs.push(arg);
  }
  popup(opts: PopupOpts): void {
    popupCalls.push(opts);
  }
}
const fakeWindow = { id: "main-window" };
const fromWebContentsMock = mock((_sender: unknown): unknown => fakeWindow);
const appOnMock = mock((_event: string, _listener: () => void) => undefined);
mock.module("electron", () => ({
  app: { on: appOnMock },
  ShareMenu: ShareMenuMock,
  BrowserWindow: { fromWebContents: fromWebContentsMock },
}));

// `ShareMenu` wraps `NSSharingServicePicker`, so the handler guards on
// `process.platform`. Force darwin so the happy-path tests run on the Linux CI
// host — matching how `dock.test.ts` defines `process.resourcesPath`.
// `configurable` lets the guard test flip it and restore.
const setPlatform = (value: NodeJS.Platform): void => {
  Object.defineProperty(process, "platform", { value, configurable: true });
};
setPlatform("darwin");

const { installShare, sweepShareDirs } = await import("./share");

// Idempotent — a second call must not double-register (module-level flag).
installShare();
installShare();

// installShare kicks off a startup sweep (a `readdir`) and registers the
// before-quit cleanup synchronously; snapshot both before `beforeEach` clears
// the mocks.
const readdirCallsAtInstall = readdirMock.mock.calls.length;
const beforeQuitListener = appOnMock.mock.calls.find(
  (call) => call[0] === "before-quit",
)?.[1] as (() => void) | undefined;

const shareReg = (): Registration =>
  handleRegistrations.find((r) => r.channel === "vellum:share:file")!;

// A stand-in for `IpcMainInvokeEvent` — the handler only reads `.sender`.
const fakeSender = { id: 1 };
const fakeEvent = { sender: fakeSender };

const bytes = new Uint8Array([1, 2, 3, 4]);
const expectedDir = `${path.join(tmpdir(), "vellum-share-")}abc123`;

beforeEach(() => {
  shareMenuArgs.length = 0;
  popupCalls.length = 0;
  mkdtempMock.mockClear();
  writeFileMock.mockClear();
  rmMock.mockClear();
  readdirMock.mockReset();
  readdirMock.mockReturnValue(Promise.resolve<string[]>([]));
  fromWebContentsMock.mockReset();
  fromWebContentsMock.mockReturnValue(fakeWindow);
  setPlatform("darwin");
});

describe("installShare wiring", () => {
  test("registers vellum:share:file exactly once over the invocable `handle` path", () => {
    const matches = handleRegistrations.filter(
      (r) => r.channel === "vellum:share:file",
    );
    expect(matches).toHaveLength(1);
  });

  test("sweeps once at startup and registers a before-quit cleanup", () => {
    // Startup sweep ran (one `readdir`) and idempotency held — two
    // installShare() calls, still a single sweep + before-quit registration.
    expect(readdirCallsAtInstall).toBe(1);
    expect(beforeQuitListener).toBeDefined();
    expect(
      appOnMock.mock.calls.filter((call) => call[0] === "before-quit"),
    ).toHaveLength(1);
  });
});

describe("ShareFileArgs schema", () => {
  test("accepts a [Uint8Array, non-empty string] tuple", () => {
    expect(shareReg().schema.safeParse([bytes, "report.pdf"]).success).toBe(
      true,
    );
  });

  test("rejects an empty filename", () => {
    expect(shareReg().schema.safeParse([bytes, ""]).success).toBe(false);
  });

  test("rejects wrong types, missing args, and extra args", () => {
    const schema = shareReg().schema;
    expect(schema.safeParse(["not-bytes", "report.pdf"]).success).toBe(false);
    expect(schema.safeParse([bytes]).success).toBe(false);
    expect(schema.safeParse([bytes, 42]).success).toBe(false);
    expect(schema.safeParse([bytes, "report.pdf", "extra"]).success).toBe(
      false,
    );
    expect(schema.safeParse([]).success).toBe(false);
  });
});

describe("share handler", () => {
  test("writes the bytes to a fresh temp file and presents that path", async () => {
    // WHEN the renderer shares a file
    await shareReg().fn([bytes, "report.pdf"], fakeEvent);

    // THEN the bytes are written under a throwaway temp dir…
    expect(mkdtempMock).toHaveBeenCalledWith(
      path.join(tmpdir(), "vellum-share-"),
    );
    const expectedPath = path.join(expectedDir, "report.pdf");
    expect(writeFileMock).toHaveBeenCalledWith(expectedPath, bytes);

    // …and the sheet is opened for exactly that path.
    expect(shareMenuArgs).toEqual([{ filePaths: [expectedPath] }]);
    expect(popupCalls).toHaveLength(1);
  });

  test("strips path components from the renderer filename, keeping the write inside the temp dir", async () => {
    // WHEN a filename carries directory traversal
    await shareReg().fn([bytes, "../../etc/passwd"], fakeEvent);

    // THEN only the basename is used, so the write stays in the temp dir
    const expectedPath = path.join(expectedDir, "passwd");
    expect(writeFileMock).toHaveBeenCalledWith(expectedPath, bytes);
    expect(shareMenuArgs).toEqual([{ filePaths: [expectedPath] }]);
  });

  test("anchors the sheet to the sender's BrowserWindow", async () => {
    await shareReg().fn([bytes, "report.pdf"], fakeEvent);

    expect(fromWebContentsMock).toHaveBeenCalledWith(fakeSender);
    expect(popupCalls[0]!.window).toBe(fakeWindow);
  });

  test("presents an unanchored sheet when the sender has no window", async () => {
    // GIVEN the sender's WebContents has no owning BrowserWindow
    fromWebContentsMock.mockReturnValue(null);

    // WHEN the file is shared
    await shareReg().fn([bytes, "report.pdf"], fakeEvent);

    // THEN the sheet still opens, just unanchored (undefined, not null)
    expect(popupCalls[0]!.window).toBeUndefined();
  });

  test("does not delete the temp dir on menu close", async () => {
    await shareReg().fn([bytes, "report.pdf"], fakeEvent);

    // Cleanup is intentionally NOT wired to the picker closing: Electron's
    // popup callback fires on menu close (service selected), not when the
    // service is done reading the file, so no teardown callback is passed and
    // the share itself removes nothing.
    expect(popupCalls[0]!.callback).toBeUndefined();
    expect(rmMock).not.toHaveBeenCalled();
  });

  test("rejects on a non-darwin host without touching the filesystem", async () => {
    // GIVEN a non-macOS shell (the picker wraps NSSharingServicePicker)
    setPlatform("linux");

    // WHEN a share is attempted THEN it fails loudly and writes nothing
    await expect(
      shareReg().fn([bytes, "report.pdf"], fakeEvent),
    ).rejects.toThrow(/only available on macOS/);
    expect(mkdtempMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(shareMenuArgs).toHaveLength(0);
  });
});

describe("sweepShareDirs", () => {
  test("removes only vellum-share-* dirs, leaving unrelated temp entries", async () => {
    readdirMock.mockReturnValue(
      Promise.resolve([
        "vellum-share-aaa",
        "vellum-mac-helper-permission-x",
        "some-other-app",
        "vellum-share-bbb",
      ]),
    );

    await sweepShareDirs();

    expect(readdirMock).toHaveBeenCalledWith(tmpdir());
    expect(rmMock).toHaveBeenCalledTimes(2);
    expect(rmMock).toHaveBeenCalledWith(
      path.join(tmpdir(), "vellum-share-aaa"),
      { recursive: true, force: true },
    );
    expect(rmMock).toHaveBeenCalledWith(
      path.join(tmpdir(), "vellum-share-bbb"),
      { recursive: true, force: true },
    );
  });

  test("no-ops when the temp dir holds no share dirs", async () => {
    readdirMock.mockReturnValue(
      Promise.resolve(["vellum-mac-helper-permission-x", "unrelated"]),
    );

    await sweepShareDirs();

    expect(rmMock).not.toHaveBeenCalled();
  });

  test("swallows a readdir failure without throwing or deleting", async () => {
    readdirMock.mockImplementation(() =>
      Promise.reject(new Error("tmpdir unreadable")),
    );

    await expect(sweepShareDirs()).resolves.toBeUndefined();
    expect(rmMock).not.toHaveBeenCalled();
  });

  test("the before-quit listener triggers a sweep", async () => {
    readdirMock.mockReturnValue(Promise.resolve(["vellum-share-ccc"]));

    // Invoke the captured before-quit listener; it fires the sweep.
    beforeQuitListener?.();
    // Let the fire-and-forget sweep settle (a macrotask flushes microtasks).
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rmMock).toHaveBeenCalledWith(
      path.join(tmpdir(), "vellum-share-ccc"),
      { recursive: true, force: true },
    );
  });
});
