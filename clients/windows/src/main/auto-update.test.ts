import { describe, expect, mock, test } from "bun:test";

import {
  UPDATE_CHECK,
  UPDATE_GET_STATE,
  UPDATE_INSTALL,
} from "@vellumai/ipc-contract";
import { resolveUpdateFeedUrl } from "@vellumai/electron-desktop/auto-update";

const registeredChannels: string[] = [];
const feedUrls: string[] = [];

mock.module("electron-updater", () => ({
  autoUpdater: {
    checkForUpdates: () => Promise.resolve(null),
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    channel: "",
    allowDowngrade: false,
    setFeedURL: (options: { url: string }) => {
      feedUrls.push(options.url);
    },
    on: () => undefined,
    quitAndInstall: () => undefined,
  },
}));

mock.module("./logger", () => ({
  default: {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  },
  getLogFilePaths: () => [],
}));

mock.module("./ipc.client", () => ({
  handle: (channel: string) => {
    registeredChannels.push(channel);
  },
  handleSync: () => undefined,
  on: () => undefined,
}));

const { installAutoUpdate, windowsUpdateFeedUrl } =
  await import("./auto-update");

describe("windowsUpdateFeedUrl", () => {
  test("targets the architecture-specific win-electron feed", () => {
    // Tests build without __VELLUM_ENVIRONMENT__, so the channel defaults
    // to production and the bucket collapses to prod.
    expect(windowsUpdateFeedUrl("x64")).toBe(
      "https://storage.googleapis.com/vellum-ai-prod-releases/win-electron/x64/",
    );
    expect(windowsUpdateFeedUrl("arm64")).toBe(
      "https://storage.googleapis.com/vellum-ai-prod-releases/win-electron/arm64/",
    );
  });
});

describe("resolveUpdateFeedUrl", () => {
  test("keeps environments, architectures, and platforms isolated", () => {
    const feeds = [
      resolveUpdateFeedUrl("production", "win-electron", "x64"),
      resolveUpdateFeedUrl("production", "win-electron", "arm64"),
      resolveUpdateFeedUrl("staging", "win-electron", "x64"),
      resolveUpdateFeedUrl("dev", "win-electron", "x64"),
      resolveUpdateFeedUrl("production", "mac-electron", "x64"),
    ];
    expect(new Set(feeds).size).toBe(feeds.length);
    expect(resolveUpdateFeedUrl("staging", "win-electron", "arm64")).toBe(
      "https://storage.googleapis.com/vellum-ai-staging-releases/win-electron/arm64/",
    );
  });
});

describe("installAutoUpdate", () => {
  test("registers update IPC but leaves the updater idle when unpackaged", () => {
    installAutoUpdate();

    expect(registeredChannels).toEqual([
      UPDATE_GET_STATE,
      UPDATE_CHECK,
      UPDATE_INSTALL,
    ]);
    expect(feedUrls).toEqual([]);
  });
});
