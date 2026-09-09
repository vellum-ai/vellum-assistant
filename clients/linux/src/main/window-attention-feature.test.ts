import { beforeEach, describe, expect, mock, test } from "bun:test";

// The shared publisher reaches `electron`'s `BrowserWindow`, which does not
// exist outside an Electron runtime; only the install seam is under test here.
// Publishing behavior is covered in packages/electron-desktop.
const quitListeners: Array<() => void> = [];
mock.module("electron", () => ({
  app: {
    once: (event: string, listener: () => void) => {
      if (event === "before-quit") {
        quitListeners.push(listener);
      }
    },
  },
}));

const installs = { count: 0 };
const teardown = mock(() => undefined);
mock.module("@vellumai/electron-desktop/window-attention", () => ({
  installWindowAttention: () => {
    installs.count += 1;
    return teardown;
  },
}));

const { default: windowAttentionFeature } =
  await import("./features/window-attention");
const { DesktopCapabilityRegistry } =
  await import("@vellumai/electron-desktop/capability-registry");

beforeEach(() => {
  quitListeners.length = 0;
  installs.count = 0;
  teardown.mockClear();
});

describe("window attention feature", () => {
  // Its own capability rather than a line inside notifications: the renderer
  // spends this signal on presence reporting, so disabling toasts must not
  // also tell the daemon that a minimized desktop is watching.
  test("installs the publisher and tears it down on quit", () => {
    windowAttentionFeature.install(new DesktopCapabilityRegistry());

    expect(installs.count).toBe(1);
    expect(teardown).not.toHaveBeenCalled();

    expect(quitListeners).toHaveLength(1);
    quitListeners[0]!();
    expect(teardown).toHaveBeenCalledTimes(1);
  });
});
