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

// `node:fs/promises` is mocked so the temp-file dance and the stale-dir sweep
// are asserted structurally — no real disk access. `node:os` / `node:path`
// stay real (pure helpers), so the asserted paths match what production builds.
const mkdtempMock = mock((prefix: string) =>
  Promise.resolve(`${prefix}abc123`),
);
const writeFileMock = mock((_path: string, _data: unknown) =>
  Promise.resolve(),
);
const readdirMock = mock((_path: string) => Promise.resolve<string[]>([]));
const rmMock = mock((_path: string, _opts: unknown) => Promise.resolve());
const statMock = mock((_path: string) => Promise.resolve({ mtimeMs: 0 }));
mock.module("node:fs/promises", () => ({
  mkdtemp: mkdtempMock,
  writeFile: writeFileMock,
  readdir: readdirMock,
  rm: rmMock,
  stat: statMock,
}));

// Mock the electron seams `share.ts` touches: the `ShareMenu` picker and
// `BrowserWindow` (used to anchor the sheet to the calling window). `ShareMenu`
// records its constructor arg + `popup` options so the tests can assert the
// file path and that no teardown callback is wired to menu close.
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
mock.module("electron", () => ({
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

const { installShare, sweepStaleShareDirs } = await import("./share");

// Idempotent — a second call must not double-register (module-level flag).
installShare();
installShare();

// installShare kicks off a startup sweep (a `readdir`) synchronously; snapshot
// the call count before `beforeEach` clears the mocks.
const readdirCallsAtInstall = readdirMock.mock.calls.length;

const shareReg = (): Registration =>
  handleRegistrations.find((r) => r.channel === "vellum:share:file")!;

// A stand-in for `IpcMainInvokeEvent` — the handler only reads `.sender`.
const fakeSender = { id: 1 };
const fakeEvent = { sender: fakeSender };

const bytes = new Uint8Array([1, 2, 3, 4]);
const expectedDir = `${path.join(tmpdir(), "vellum-share-")}abc123`;
const STALE_MS = 60 * 60 * 1000;

beforeEach(() => {
  shareMenuArgs.length = 0;
  popupCalls.length = 0;
  mkdtempMock.mockClear();
  writeFileMock.mockClear();
  rmMock.mockClear();
  readdirMock.mockReset();
  readdirMock.mockReturnValue(Promise.resolve<string[]>([]));
  statMock.mockReset();
  statMock.mockImplementation((_path: string) =>
    Promise.resolve({ mtimeMs: Date.now() }),
  );
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

  test("kicks off a single startup sweep (idempotent across repeat installs)", () => {
    expect(readdirCallsAtInstall).toBe(1);
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

  test("wires no teardown callback and does not delete the fresh temp dir", async () => {
    await shareReg().fn([bytes, "report.pdf"], fakeEvent);

    // Cleanup is intentionally NOT wired to the picker closing: Electron's
    // popup callback fires on menu close (service selected), not when the
    // service is done reading the file. No teardown callback is passed, and the
    // just-written (fresh) dir is never swept — only stale dirs are.
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

describe("sweepStaleShareDirs", () => {
  const dirPath = (name: string): string => path.join(tmpdir(), name);

  test("removes only stale vellum-share-* dirs, sparing fresh ones and unrelated entries", async () => {
    const now = Date.now();
    const mtimes: Record<string, number> = {
      "vellum-share-old": now - 2 * STALE_MS, // stale → removed
      "vellum-share-fresh": now - 1000, // in-flight → kept
      "vellum-share-old2": now - (STALE_MS + 5000), // stale → removed
    };
    readdirMock.mockReturnValue(
      Promise.resolve([
        "vellum-share-old",
        "vellum-share-fresh",
        "vellum-mac-helper-permission-x",
        "vellum-share-old2",
      ]),
    );
    statMock.mockImplementation((p: string) =>
      Promise.resolve({ mtimeMs: mtimes[path.basename(p)] ?? now }),
    );

    await sweepStaleShareDirs();

    expect(rmMock).toHaveBeenCalledTimes(2);
    expect(rmMock).toHaveBeenCalledWith(dirPath("vellum-share-old"), {
      recursive: true,
      force: true,
    });
    expect(rmMock).toHaveBeenCalledWith(dirPath("vellum-share-old2"), {
      recursive: true,
      force: true,
    });
    // A fresh share dir might still be open by the selected service — never
    // deleted, even though it matches the prefix.
    expect(rmMock).not.toHaveBeenCalledWith(
      dirPath("vellum-share-fresh"),
      expect.anything(),
    );
    // Unrelated temp dirs aren't even stat'd.
    expect(statMock).not.toHaveBeenCalledWith(
      dirPath("vellum-mac-helper-permission-x"),
    );
  });

  test("leaves everything in place when no share dir is stale", async () => {
    const now = Date.now();
    readdirMock.mockReturnValue(
      Promise.resolve(["vellum-share-a", "vellum-share-b"]),
    );
    statMock.mockImplementation(() => Promise.resolve({ mtimeMs: now - 1000 }));

    await sweepStaleShareDirs();

    expect(rmMock).not.toHaveBeenCalled();
  });

  test("swallows a readdir failure without throwing or deleting", async () => {
    readdirMock.mockImplementation(() =>
      Promise.reject(new Error("tmpdir unreadable")),
    );

    await expect(sweepStaleShareDirs()).resolves.toBeUndefined();
    expect(rmMock).not.toHaveBeenCalled();
  });

  test("a stat failure on one dir doesn't block sweeping the others", async () => {
    const now = Date.now();
    readdirMock.mockReturnValue(
      Promise.resolve(["vellum-share-bad", "vellum-share-old"]),
    );
    statMock.mockImplementation((p: string) =>
      path.basename(p) === "vellum-share-bad"
        ? Promise.reject(new Error("stat failed"))
        : Promise.resolve({ mtimeMs: now - 2 * STALE_MS }),
    );

    await expect(sweepStaleShareDirs()).resolves.toBeUndefined();
    expect(rmMock).toHaveBeenCalledTimes(1);
    expect(rmMock).toHaveBeenCalledWith(dirPath("vellum-share-old"), {
      recursive: true,
      force: true,
    });
  });
});
