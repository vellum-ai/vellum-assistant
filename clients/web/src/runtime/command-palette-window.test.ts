import { afterEach, describe, expect, mock, test } from "bun:test";

let runningInElectron = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => runningInElectron,
}));

const {
  dismissCommandPaletteWindow,
  openCommandPaletteWindow,
  selectCommandPaletteCommand,
} = await import("./command-palette-window");

afterEach(() => {
  runningInElectron = false;
  delete (window as { vellum?: unknown }).vellum;
});

describe("openCommandPaletteWindow", () => {
  test("returns false off Electron so callers can use the in-page fallback", async () => {
    const open = mock(() => Promise.resolve());
    (window as { vellum?: unknown }).vellum = { commandPalette: { open } };

    expect(await openCommandPaletteWindow()).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  test("returns false for older Electron shells without the palette bridge", async () => {
    runningInElectron = true;
    (window as { vellum?: unknown }).vellum = { platform: "electron" };

    expect(await openCommandPaletteWindow()).toBe(false);
  });

  test("opens through the bridge on newer Electron shells", async () => {
    runningInElectron = true;
    const open = mock(() => Promise.resolve());
    (window as { vellum?: unknown }).vellum = {
      platform: "electron",
      commandPalette: { open },
    };

    expect(await openCommandPaletteWindow()).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("command palette bridge actions", () => {
  test("dismiss and select no-op when the bridge is absent", async () => {
    runningInElectron = true;
    (window as { vellum?: unknown }).vellum = { platform: "electron" };

    await expect(dismissCommandPaletteWindow()).resolves.toBeUndefined();
    await expect(
      selectCommandPaletteCommand({ kind: "openSettings" }),
    ).resolves.toBeUndefined();
  });

  test("dismisses and selects through the bridge when present", async () => {
    runningInElectron = true;
    const dismiss = mock(() => Promise.resolve());
    const select = mock(() => Promise.resolve());
    (window as { vellum?: unknown }).vellum = {
      platform: "electron",
      commandPalette: { dismiss, select },
    };

    await dismissCommandPaletteWindow();
    await selectCommandPaletteCommand({ kind: "home" });

    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(select).toHaveBeenCalledWith({ kind: "home" });
  });
});
