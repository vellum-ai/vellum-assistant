import { beforeEach, describe, expect, mock, test } from "bun:test";
import { tmpdir } from "node:os";
import path from "node:path";

import type { z } from "zod";

// Capture the invocable IPC registration `installShare` makes so the tests
// can drive the handler directly without a real `ipcMain`. The sender-origin
// guard inside the real `handle` is covered by `ipc.test.ts`, so it's
// intentionally absent here (mirrors `dock.test.ts`).
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

// `node:fs/promises` is mocked so the handler's temp-file dance is asserted
// structurally — no real disk writes, and the fire-and-forget cleanup in the
// sheet-close callback becomes observable via `rmMock`. `node:os` / `node:path`
// stay real (pure helpers), so the asserted paths match what production builds.
const mkdtempMock = mock((prefix: string) =>
  Promise.resolve(`${prefix}abc123`),
);
const writeFileMock = mock((_path: string, _data: unknown) =>
  Promise.resolve(),
);
const rmMock = mock((_path: string, _opts: unknown) => Promise.resolve());
mock.module("node:fs/promises", () => ({
  mkdtemp: mkdtempMock,
  writeFile: writeFileMock,
  rm: rmMock,
}));

// Mock the two electron seams `share.ts` touches: the `ShareMenu` picker and
// `BrowserWindow.fromWebContents` (used to anchor the sheet to the calling
// window). `ShareMenu` records its constructor arg + `popup` options so the
// tests can assert the file path and teardown callback.
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

const { installShare } = await import("./share");

// Idempotent — a second call must not double-register (module-level flag).
installShare();
installShare();

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
  fromWebContentsMock.mockClear();
  fromWebContentsMock.mockReturnValue(fakeWindow);
  setPlatform("darwin");
});

describe("installShare IPC registration", () => {
  test("registers vellum:share:file exactly once over the invocable `handle` path", () => {
    const matches = handleRegistrations.filter(
      (r) => r.channel === "vellum:share:file",
    );
    expect(matches).toHaveLength(1);
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

  test("tears down the temp dir when the sheet closes", async () => {
    await shareReg().fn([bytes, "report.pdf"], fakeEvent);

    // The temp dir is only removed once the sheet closes, via the popup
    // callback — not eagerly, or the file would vanish before a target reads it.
    expect(rmMock).not.toHaveBeenCalled();
    popupCalls[0]!.callback?.();
    expect(rmMock).toHaveBeenCalledWith(expectedDir, {
      recursive: true,
      force: true,
    });
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
