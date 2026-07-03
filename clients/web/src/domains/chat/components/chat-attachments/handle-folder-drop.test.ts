/**
 * Tests the routing logic that turns dropped folders into either resolved
 * filesystem paths (Electron) or a rejection signal (web). The critical
 * contract: on web, no path is resolved and the caller learns that every
 * dropped folder was unresolved so it can surface the standard error notice.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

const getNativePathForFileMock = mock((_file: File): string | null => null);
mock.module("@/runtime/file-paths", () => ({
  getNativePathForFile: getNativePathForFileMock,
}));

const { resolveDroppedDirectories, WEB_FOLDER_DROP_ERROR } = await import(
  "./handle-folder-drop"
);

afterEach(() => {
  getNativePathForFileMock.mockReset();
});

describe("resolveDroppedDirectories", () => {
  test("returns an empty result and marks every folder unresolved on web", () => {
    getNativePathForFileMock.mockImplementation(() => null);
    const folders = [
      new File([], "src", { type: "" }),
      new File([], "docs", { type: "" }),
    ];

    const outcome = resolveDroppedDirectories(folders);

    expect(outcome.resolvedPaths).toEqual([]);
    expect(outcome.unresolvedCount).toBe(2);
  });

  test("resolves every folder to its native path when Electron is available", () => {
    getNativePathForFileMock.mockImplementation((file) =>
      `/Users/example/${(file as File).name}`,
    );
    const folders = [
      new File([], "app", { type: "" }),
      new File([], "lib", { type: "" }),
    ];

    const outcome = resolveDroppedDirectories(folders);

    expect(outcome.resolvedPaths).toEqual([
      "/Users/example/app",
      "/Users/example/lib",
    ]);
    expect(outcome.unresolvedCount).toBe(0);
  });

  test("reports the partial-resolution case when only some folders come back with a path", () => {
    let call = 0;
    getNativePathForFileMock.mockImplementation(() => {
      call += 1;
      return call === 1 ? "/Users/example/only-resolved" : null;
    });
    const folders = [
      new File([], "only-resolved", { type: "" }),
      new File([], "unknown", { type: "" }),
    ];

    const outcome = resolveDroppedDirectories(folders);

    expect(outcome.resolvedPaths).toEqual(["/Users/example/only-resolved"]);
    expect(outcome.unresolvedCount).toBe(1);
  });

  test("exposes the web-rejection copy for callers to display in the composer error slot", () => {
    // Anchor the message shape so the /docs and the UI don't drift.
    expect(WEB_FOLDER_DROP_ERROR).toMatch(/desktop app/i);
    expect(WEB_FOLDER_DROP_ERROR).toMatch(/folder/i);
  });
});
