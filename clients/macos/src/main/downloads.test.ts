import { beforeEach, describe, expect, mock, test } from "bun:test";
import path from "node:path";

// `node:fs` is mocked so the save-path resolution is asserted structurally —
// no real disk access. `node:path` stays real (pure helper), so the asserted
// paths match what production builds. Mirrors `share.test.ts`.
const existsSyncMock = mock((_p: string) => false);
const mkdirSyncMock = mock((_p: string, _opts: unknown) => undefined);
mock.module("node:fs", () => ({
  existsSync: existsSyncMock,
  mkdirSync: mkdirSyncMock,
}));

// Capture the `will-download` listener so tests can drive it directly without
// a real Electron session.
type DownloadListener = (event: unknown, item: FakeItem) => void;
const willDownloadListeners: DownloadListener[] = [];
const downloadFinishedMock = mock((_p: string) => undefined);
const getPathMock = mock((_name: string) => "/Users/tester/Downloads");
mock.module("electron", () => ({
  app: {
    getPath: getPathMock,
    dock: { downloadFinished: downloadFinishedMock },
  },
  session: {
    defaultSession: {
      on: (channel: string, listener: DownloadListener) => {
        if (channel === "will-download") willDownloadListeners.push(listener);
      },
    },
  },
}));

// Stand-in for Electron's `DownloadItem`: records the save path and replays
// the `done` event on demand.
class FakeItem {
  savePaths: string[] = [];
  private doneHandlers: Array<(event: unknown, state: string) => void> = [];
  constructor(private filename: string) {}
  getFilename(): string {
    return this.filename;
  }
  setSavePath(p: string): void {
    this.savePaths.push(p);
  }
  once(event: string, handler: (event: unknown, state: string) => void): void {
    if (event === "done") this.doneHandlers.push(handler);
  }
  finish(state: string): void {
    for (const handler of this.doneHandlers) handler({}, state);
  }
}

const { installDownloads, uniqueDownloadPath } = await import("./downloads");

// Idempotent — a second call must not double-register (module-level flag).
installDownloads();
installDownloads();

const DOWNLOADS = "/Users/tester/Downloads";
const fire = (item: FakeItem): void => {
  willDownloadListeners[0]!({}, item);
};

beforeEach(() => {
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(false);
  mkdirSyncMock.mockClear();
  downloadFinishedMock.mockClear();
  getPathMock.mockClear();
  getPathMock.mockReturnValue(DOWNLOADS);
});

describe("installDownloads wiring", () => {
  test("subscribes to will-download exactly once across repeat installs", () => {
    expect(willDownloadListeners).toHaveLength(1);
  });
});

describe("uniqueDownloadPath", () => {
  test("uses the plain name when nothing collides", () => {
    expect(uniqueDownloadPath(DOWNLOADS, "report.pdf", () => false)).toBe(
      path.join(DOWNLOADS, "report.pdf"),
    );
  });

  test("suffixes ' (n)' before the extension on collision, Finder-style", () => {
    const taken = new Set([
      path.join(DOWNLOADS, "report.pdf"),
      path.join(DOWNLOADS, "report (1).pdf"),
    ]);

    expect(uniqueDownloadPath(DOWNLOADS, "report.pdf", (c) => taken.has(c))).toBe(
      path.join(DOWNLOADS, "report (2).pdf"),
    );
  });

  test("handles extensionless and dotfile names without mangling them", () => {
    const taken = new Set([
      path.join(DOWNLOADS, "LICENSE"),
      path.join(DOWNLOADS, ".env"),
    ]);
    const exists = (c: string): boolean => taken.has(c);

    expect(uniqueDownloadPath(DOWNLOADS, "LICENSE", exists)).toBe(
      path.join(DOWNLOADS, "LICENSE (1)"),
    );
    // `.env` is all "extension" to path.extname; the stem must not go empty.
    expect(uniqueDownloadPath(DOWNLOADS, ".env", exists)).toBe(
      path.join(DOWNLOADS, ".env (1)"),
    );
  });

  test("strips path components so a download can't escape the directory", () => {
    expect(
      uniqueDownloadPath(DOWNLOADS, "../../etc/passwd", () => false),
    ).toBe(path.join(DOWNLOADS, "passwd"));
  });

  test("returns null rather than looping forever when every name is taken", () => {
    expect(uniqueDownloadPath(DOWNLOADS, "report.pdf", () => true)).toBeNull();
  });
});

describe("will-download handling", () => {
  test("files the download into ~/Downloads instead of prompting a Save panel", () => {
    const item = new FakeItem("report.pdf");

    fire(item);

    expect(item.savePaths).toEqual([path.join(DOWNLOADS, "report.pdf")]);
    expect(mkdirSyncMock).toHaveBeenCalledTimes(1);
  });

  test("uniquifies against an existing file rather than clobbering it", () => {
    existsSyncMock.mockImplementation(
      (c: string) => c === path.join(DOWNLOADS, "report.pdf"),
    );

    const item = new FakeItem("report.pdf");
    fire(item);

    expect(item.savePaths).toEqual([path.join(DOWNLOADS, "report (1).pdf")]);
  });

  test("bounces the Dock's Downloads stack once the download completes", () => {
    const item = new FakeItem("report.pdf");
    fire(item);

    item.finish("completed");

    expect(downloadFinishedMock).toHaveBeenCalledWith(
      path.join(DOWNLOADS, "report.pdf"),
    );
  });

  test("stays quiet for a cancelled or interrupted download", () => {
    const item = new FakeItem("report.pdf");
    fire(item);

    item.finish("cancelled");
    item.finish("interrupted");

    expect(downloadFinishedMock).not.toHaveBeenCalled();
  });

  test("defers to Electron's default save routine when the directory is unusable", () => {
    mkdirSyncMock.mockImplementationOnce(() => {
      throw new Error("EACCES");
    });

    const item = new FakeItem("report.pdf");
    expect(() => fire(item)).not.toThrow();
    expect(item.savePaths).toEqual([]);
  });
});
