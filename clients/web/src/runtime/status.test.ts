import { afterEach, describe, expect, mock, test } from "bun:test";

// Control the host branch directly so each case exercises one transport.
let runningInElectron = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => runningInElectron,
}));

const { setAssistantStatus } = await import("./status");

afterEach(() => {
  runningInElectron = false;
  delete (window as { vellum?: unknown }).vellum;
});

describe("setAssistantStatus", () => {
  test("no-ops off Electron", () => {
    const setConnection = mock(() => {});
    (window as { vellum?: unknown }).vellum = { status: { setConnection } };

    setAssistantStatus("thinking");

    expect(setConnection).not.toHaveBeenCalled();
  });

  test("publishes the status over the bridge on Electron", () => {
    runningInElectron = true;
    const setConnection = mock(() => {});
    (window as { vellum?: unknown }).vellum = { status: { setConnection } };

    setAssistantStatus("thinking");

    expect(setConnection).toHaveBeenCalledTimes(1);
    expect(setConnection).toHaveBeenCalledWith("thinking");
  });

  // Version skew: a newer web bundle can run against an older preload whose
  // platform is still "electron" but which predates the status channel. The
  // call must no-op rather than throw on RootLayout mount.
  test("no-ops when the older preload lacks the status channel", () => {
    runningInElectron = true;
    (window as { vellum?: unknown }).vellum = { platform: "electron" };

    expect(() => setAssistantStatus("thinking")).not.toThrow();
  });
});
