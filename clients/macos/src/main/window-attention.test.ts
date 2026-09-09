import { beforeEach, describe, expect, mock, test } from "bun:test";

// The shared publisher reaches `electron`'s `BrowserWindow`, which does not
// exist outside an Electron runtime; only the install seam is under test here.
// Publishing behavior is covered in packages/electron-desktop.
type Listener = () => void;
const onceListeners = new Map<string, Listener[]>();
const onListeners = new Map<string, Listener[]>();
const record = (
  registry: Map<string, Listener[]>,
  event: string,
  listener: Listener,
): void => {
  registry.set(event, [...(registry.get(event) ?? []), listener]);
};
mock.module("electron", () => ({
  app: {
    once: (event: string, listener: Listener) => {
      record(onceListeners, event, listener);
    },
    on: (event: string, listener: Listener) => {
      record(onListeners, event, listener);
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

const { installWindowAttentionFeature } = await import("./window-attention");

beforeEach(() => {
  onceListeners.clear();
  onListeners.clear();
  installs.count = 0;
  teardown.mockClear();
});

describe("installWindowAttentionFeature", () => {
  test("installs the publisher and tears it down on quit", () => {
    installWindowAttentionFeature();

    expect(installs.count).toBe(1);
    expect(teardown).not.toHaveBeenCalled();

    const quitListeners = onceListeners.get("before-quit") ?? [];
    expect(quitListeners).toHaveLength(1);
    quitListeners[0]!();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  // `before-quit` can fire more than once, so a subscription that stays
  // attached would tear the publisher down again after a later install.
  test("subscribes to the first quit only", () => {
    installWindowAttentionFeature();

    expect(onListeners.get("before-quit")).toBeUndefined();
  });
});
