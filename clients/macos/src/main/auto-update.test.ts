import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Regression cover for the auto-updater's leaked download promise.
 *
 * With `autoDownload` enabled, `checkForUpdates()` resolves with the in-flight
 * download on `result.downloadPromise` instead of folding it into the returned
 * promise, and electron-updater re-throws every download failure on it (see
 * `AppUpdater.downloadUpdate`). A `.catch()` on `checkForUpdates()` alone
 * therefore never sees a failed download, and the rejection escapes into the
 * main process as an unhandled rejection.
 */

interface FakeUpdater {
  checkForUpdates: () => Promise<{ downloadPromise: Promise<unknown> | null }>;
  logger: unknown;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  channel: string;
  allowDowngrade: boolean;
  setFeedURL: () => void;
  on: () => void;
  quitAndInstall: () => void;
}

let downloadResult: { downloadPromise: Promise<unknown> | null } = {
  downloadPromise: null,
};

const fakeUpdater: FakeUpdater = {
  checkForUpdates: () => Promise.resolve(downloadResult),
  logger: undefined,
  autoDownload: false,
  autoInstallOnAppQuit: false,
  channel: "",
  allowDowngrade: false,
  setFeedURL: () => undefined,
  on: () => undefined,
  quitAndInstall: () => undefined,
};

mock.module("electron-updater", () => ({ autoUpdater: fakeUpdater }));

const { checkForUpdates } = await import("./auto-update");

/** Collect unhandled rejections raised while `run` settles. */
const unhandledDuring = async (run: () => void): Promise<unknown[]> => {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    run();
    // Two macrotask hops: one for `checkForUpdates()` to resolve and the
    // handler to attach, one for the runtime to report anything still
    // unhandled after that.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return seen;
};

describe("checkForUpdates", () => {
  beforeEach(() => {
    downloadResult = { downloadPromise: null };
  });

  afterEach(() => {
    downloadResult = { downloadPromise: null };
  });

  test("swallows a rejected downloadPromise instead of leaking it", async () => {
    const readOnlyVolume = new Error(
      "Cannot update while running on a read-only volume.",
    );
    downloadResult = { downloadPromise: Promise.reject(readOnlyVolume) };

    const unhandled = await unhandledDuring(() => {
      checkForUpdates();
    });

    expect(unhandled).toEqual([]);
  });

  test("tolerates a check that reports no download in flight", async () => {
    downloadResult = { downloadPromise: null };

    const unhandled = await unhandledDuring(() => {
      checkForUpdates();
    });

    expect(unhandled).toEqual([]);
  });
});
