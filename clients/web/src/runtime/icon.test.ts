import { afterEach, describe, expect, mock, test } from "bun:test";

// Control the host branch directly so each case exercises one transport.
let runningInElectron = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => runningInElectron,
}));

const { setAssistantIcon } = await import("./icon");

afterEach(() => {
  runningInElectron = false;
  delete (window as { vellum?: unknown }).vellum;
});

describe("setAssistantIcon", () => {
  test("no-ops off Electron", () => {
    const setAvatar = mock(() => {});
    (window as { vellum?: unknown }).vellum = { icon: { setAvatar } };

    setAssistantIcon(new Uint8Array([1]));

    expect(setAvatar).not.toHaveBeenCalled();
  });

  test("publishes the avatar bytes over the bridge on Electron", () => {
    runningInElectron = true;
    const setAvatar = mock(() => {});
    (window as { vellum?: unknown }).vellum = { icon: { setAvatar } };

    const png = new Uint8Array([1, 2, 3]);
    setAssistantIcon(png);

    expect(setAvatar).toHaveBeenCalledTimes(1);
    expect(setAvatar).toHaveBeenCalledWith(png);
  });

  test("forwards null to clear the avatar (Vellum-mark fallback)", () => {
    runningInElectron = true;
    const setAvatar = mock(() => {});
    (window as { vellum?: unknown }).vellum = { icon: { setAvatar } };

    setAssistantIcon(null);

    expect(setAvatar).toHaveBeenCalledWith(null);
  });

  // Version skew: a newer web bundle can run against an older preload whose
  // platform is still "electron" but which predates the icon channel. The
  // call must no-op rather than throw on RootLayout mount.
  test("no-ops when the older preload lacks the icon channel", () => {
    runningInElectron = true;
    (window as { vellum?: unknown }).vellum = { platform: "electron" };

    expect(() => setAssistantIcon(new Uint8Array([1]))).not.toThrow();
  });
});
