import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SessionReplayConfig } from "@/lib/session-replay/session-replay-control";
import type { ClientOs } from "@/runtime/platform-detection";

let syncedConfig: SessionReplayConfig | undefined;
let nativePlatform = false;
let electron = false;
let clientOs: ClientOs = "web";

mock.module("@/lib/local-mode", () => ({
  getPlatformRuntimeUrl: () => "https://example.com",
}));
mock.module("@/lib/session-replay/network-sanitize", () => ({
  sessionReplayNetworkConfig: {},
}));
mock.module("@/lib/session-replay/session-replay-control", () => ({
  syncSessionReplay: (config: SessionReplayConfig) => {
    syncedConfig = config;
  },
  installSessionReplayControlListeners: () => () => {},
}));
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => electron,
}));
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => nativePlatform,
}));
mock.module("@/runtime/platform-detection", () => ({
  detectClientOs: () => clientOs,
}));

const env = import.meta.env as Record<string, string | undefined>;
env.VITE_SESSION_REPLAY_APP_ID = "example/app";

const { initSessionReplay, sessionReplayProxyBase } =
  await import("@/lib/session-replay/session-replay-init");

beforeEach(() => {
  syncedConfig = undefined;
  nativePlatform = false;
  electron = false;
  clientOs = "web";
});

describe("sessionReplayProxyBase", () => {
  test("uses the app origin on packaged Electron", () => {
    expect(
      sessionReplayProxyBase(
        { protocol: "app:", origin: "app://vellum.ai" },
        "https://app.vellum.ai",
      ),
    ).toBe("app://vellum.ai");
  });

  test("uses the platform URL on hosted and Electron-dev surfaces", () => {
    expect(
      sessionReplayProxyBase(
        { protocol: "https:", origin: "https://app.vellum.ai" },
        "https://app.vellum.ai",
      ),
    ).toBe("https://app.vellum.ai");
    expect(
      sessionReplayProxyBase(
        { protocol: "http:", origin: "http://localhost:5173" },
        "https://app.vellum.ai",
      ),
    ).toBe("https://app.vellum.ai");
  });
});

describe("initSessionReplay surface selection", () => {
  test("uses web off-native", () => {
    initSessionReplay();
    expect(syncedConfig?.surface).toBe("web");
  });

  test("uses macOS in Electron", () => {
    electron = true;
    clientOs = "macos";
    initSessionReplay();
    expect(syncedConfig?.surface).toBe("macos");
  });

  test("uses Windows in Electron", () => {
    electron = true;
    clientOs = "windows";
    initSessionReplay();
    expect(syncedConfig?.surface).toBe("windows");
  });

  test("uses iOS in the native iOS shell", () => {
    nativePlatform = true;
    clientOs = "ios";
    initSessionReplay();
    expect(syncedConfig?.surface).toBe("ios");
  });

  test("uses Android in the native Android shell", () => {
    nativePlatform = true;
    clientOs = "android";
    initSessionReplay();
    expect(syncedConfig?.surface).toBe("android");
  });
});
