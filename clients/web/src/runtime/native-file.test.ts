import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * The intent split is the contract under test: `saveFile` ("Download") must
 * never present the macOS Share Sheet, while `shareFile` ("send elsewhere")
 * must. Breaking that leaves a user who clicked Download looking at a list of
 * apps with no file saved.
 */

let isNative = false;
mock.module("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => isNative },
}));

let electron = false;
mock.module("@/runtime/is-electron", () => ({ isElectron: () => electron }));

// The Electron bridge wrapper: returns true when it presented the sheet.
let macSheetAvailable = true;
const shareFileViaMacSheet = mock(
  async (
    resolveBlob: () => Promise<Blob>,
    _filename: string,
  ): Promise<boolean> => {
    if (!macSheetAvailable) {
      return false;
    }
    await resolveBlob();
    return true;
  },
);
mock.module("@/runtime/native-share", () => ({ shareFileViaMacSheet }));

// Capacitor's share path is lazy-imported inside the function, so the plugin
// modules are mocked rather than the wrapper.
const writeFile = mock(async (_opts: unknown) => ({ uri: "file:///tmp/x" }));
const deleteFile = mock(async (_opts: unknown) => undefined);
const share = mock(async (_opts: unknown) => undefined);
mock.module("@capacitor/filesystem", () => ({
  Filesystem: { writeFile, deleteFile },
  Directory: { Cache: "CACHE" },
}));
mock.module("@capacitor/share", () => ({ Share: { share } }));

const { saveFile, shareFile } = await import("@/runtime/native-file");
const { subscribe, __resetForTesting } = await import("@/lib/event-bus");
type BusEvents = import("@/lib/event-bus").BusEventMap;

// Bus signals are the outcome contract: `download.started` on the plain-web
// handoff, `download.done` when an Electron URL fetch fails before any
// download could start. Captured through the real bus.
const started: Array<BusEvents["download.started"]> = [];
const done: Array<BusEvents["download.done"]> = [];

// Anchor clicks are the web download path; capture them instead of letting
// jsdom/happy-dom try to navigate.
const clicks: Array<{ download: string; href: string }> = [];
const originalCreateElement = document.createElement.bind(document);
document.createElement = ((tag: string) => {
  const el = originalCreateElement(tag);
  if (tag === "a") {
    (el as HTMLAnchorElement).click = () => {
      const a = el as HTMLAnchorElement;
      clicks.push({ download: a.download, href: a.href });
    };
  }
  return el;
}) as typeof document.createElement;

URL.createObjectURL = () => "blob:mock";
URL.revokeObjectURL = () => {};

const blob = new Blob(["hello"]);

const fetchMock = mock(
  async (_url: string) => new Response("bytes", { status: 200 }),
);
globalThis.fetch = fetchMock as unknown as typeof fetch;

beforeEach(() => {
  clicks.length = 0;
  isNative = false;
  electron = false;
  macSheetAvailable = true;
  mock.clearAllMocks();
  writeFile.mockResolvedValue({ uri: "file:///tmp/x" });
  fetchMock.mockResolvedValue(new Response("bytes", { status: 200 }));
  __resetForTesting();
  started.length = 0;
  done.length = 0;
  subscribe("download.started", (event) => started.push(event));
  subscribe("download.done", (event) => done.push(event));
});

describe("saveFile, the Download intent", () => {
  test("never presents the macOS Share Sheet on Electron", async () => {
    await saveFile(blob, "report.pdf");

    expect(shareFileViaMacSheet).not.toHaveBeenCalled();
    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.download).toBe("report.pdf");
  });

  test("downloads via an <a download> anchor on web", async () => {
    await saveFile("https://example.com/report.pdf", "report.pdf");

    expect(clicks).toEqual([
      { download: "report.pdf", href: "https://example.com/report.pdf" },
    ]);
  });

  test("resolves a URL source to a blob on Electron, where a cross-origin anchor would be blocked", async () => {
    electron = true;

    await saveFile("https://cdn.example.com/report.pdf", "report.pdf");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clicks).toEqual([{ download: "report.pdf", href: "blob:mock" }]);
    expect(shareFileViaMacSheet).not.toHaveBeenCalled();
  });

  test("reports a failed URL fetch on Electron instead of a dead anchor click", async () => {
    // The shell denies cross-origin top-level navigation, so a plain-anchor
    // fallback could never start a download; the honest outcome is a
    // terminal failure report on the channel main itself uses.
    electron = true;
    fetchMock.mockRejectedValueOnce(new Error("offline"));

    await saveFile("https://cdn.example.com/report.pdf", "report.pdf");

    expect(clicks).toEqual([]);
    expect(done).toEqual([{ filename: "report.pdf", state: "interrupted" }]);
    expect(started).toEqual([]);
  });

  test("announces the browser hand-off on web, and only there", async () => {
    await saveFile(blob, "report.pdf");
    expect(started).toEqual([{ filename: "report.pdf" }]);

    started.length = 0;
    electron = true;
    await saveFile(blob, "report.pdf");
    // Electron's outcome arrives from the main process as `download.done`;
    // a hand-off announcement here would double-report.
    expect(started).toEqual([]);
  });

  test("does not re-fetch a blob source on Electron", async () => {
    electron = true;

    await saveFile(blob, "report.pdf");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(clicks).toHaveLength(1);
  });

  test("still uses the Capacitor sheet on native, where blob downloads can't work", async () => {
    isNative = true;

    await saveFile(blob, "report.pdf");

    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledTimes(1);
    expect(clicks).toHaveLength(0);
  });

  test("flattens path separators in a title-derived filename on native", async () => {
    // Filesystem.writeFile reads the name as a cache-relative path; a
    // separator would point into a directory that does not exist.
    isNative = true;

    await saveFile(blob, "Q3/Q4 plan.pdf");

    const written = writeFile.mock.calls[0]?.[0] as { path: string };
    expect(written.path).toBe("Q3-Q4 plan.pdf");
  });

  test("reports a native fetch failure instead of dying before the sheet", async () => {
    isNative = true;
    fetchMock.mockRejectedValueOnce(new Error("offline"));

    await saveFile("https://cdn.example.com/report.pdf", "report.pdf");

    expect(share).not.toHaveBeenCalled();
    expect(done).toEqual([{ filename: "report.pdf", state: "interrupted" }]);
    expect(started).toEqual([]);
  });
});

describe("shareFile, the Share intent", () => {
  test("presents the macOS Share Sheet on Electron", async () => {
    await shareFile(blob, "App.vellum");

    expect(shareFileViaMacSheet).toHaveBeenCalledTimes(1);
    expect(shareFileViaMacSheet.mock.calls[0]![1]).toBe("App.vellum");
    expect(clicks).toHaveLength(0);
  });

  test("falls back to a download when the desktop bridge is unavailable", async () => {
    macSheetAvailable = false;

    await shareFile(blob, "App.vellum");

    expect(clicks).toHaveLength(1);
    expect(clicks[0]!.download).toBe("App.vellum");
  });

  test("presents the Capacitor sheet on native", async () => {
    macSheetAvailable = false;
    isNative = true;

    await shareFile(blob, "App.vellum");

    expect(share).toHaveBeenCalledTimes(1);
  });

  test("swallows a dismissed native sheet and still cleans up the temp file", async () => {
    macSheetAvailable = false;
    isNative = true;
    share.mockRejectedValueOnce(new Error("Share canceled"));

    await shareFile(blob, "App.vellum");

    expect(deleteFile).toHaveBeenCalledTimes(1);
  });
});
