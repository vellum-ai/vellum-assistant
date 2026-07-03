/**
 * Tests for the file-paths runtime wrapper. Confirms the wrapper delegates to
 * the Electron bridge on desktop and returns `null` on web so callers can
 * cleanly fall back to a rejection message.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

let runningInElectron = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => runningInElectron,
}));

const { getNativePathForFile } = await import("./file-paths");

afterEach(() => {
  runningInElectron = false;
  delete (window as { vellum?: unknown }).vellum;
});

describe("getNativePathForFile", () => {
  test("returns null off Electron even when a bridge object is present", () => {
    (window as { vellum?: unknown }).vellum = {
      paths: { getPathForFile: () => "/spoofed/path" },
    };

    const file = new File([], "example");
    expect(getNativePathForFile(file)).toBeNull();
  });

  test("delegates to the Electron bridge when running in the desktop shell", () => {
    runningInElectron = true;
    const getPathForFile = mock(() => "/Users/example/Projects/app");
    (window as { vellum?: unknown }).vellum = {
      paths: { getPathForFile },
    };

    const folder = new File([], "app");
    expect(getNativePathForFile(folder)).toBe("/Users/example/Projects/app");
    expect(getPathForFile).toHaveBeenCalledWith(folder);
  });

  test("returns null when the preload predates the paths channel (version skew)", () => {
    runningInElectron = true;
    (window as { vellum?: unknown }).vellum = { platform: "electron" };

    const file = new File([], "orphan");
    expect(getNativePathForFile(file)).toBeNull();
  });

  test("propagates null from the bridge when the file has no native path", () => {
    runningInElectron = true;
    (window as { vellum?: unknown }).vellum = {
      paths: { getPathForFile: () => null },
    };

    expect(getNativePathForFile(new File([], "in-memory"))).toBeNull();
  });
});
