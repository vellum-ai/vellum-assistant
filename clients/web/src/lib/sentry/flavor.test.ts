import { afterEach, describe, expect, mock, test } from "bun:test";

let nativePlatform = false;
let electron = false;

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => nativePlatform,
}));
mock.module("@/runtime/is-electron", () => ({ isElectron: () => electron }));
mock.module("@sentry/electron/renderer", () => ({
  init: () => {},
  getClient: () => undefined,
  getCurrentScope: () => ({ setClient: () => {} }),
}));

const { selectSentryFlavor } = await import("@/lib/sentry/flavor");
const { reactFlavor } = await import("@/lib/sentry/flavor-react");
const { capacitorFlavor } = await import("@/lib/sentry/flavor-capacitor");
const { electronFlavor } = await import("@/lib/sentry/flavor-electron");

afterEach(() => {
  nativePlatform = false;
  electron = false;
});

describe("selectSentryFlavor", () => {
  test("selects the capacitor flavor on native iOS", () => {
    nativePlatform = true;
    expect(selectSentryFlavor()).toBe(capacitorFlavor);
  });

  test("selects the react flavor on web", () => {
    expect(selectSentryFlavor()).toBe(reactFlavor);
  });

  test("selects the electron flavor in the Electron renderer", () => {
    electron = true;
    expect(selectSentryFlavor()).toBe(electronFlavor);
  });

  test("prefers the electron flavor over capacitor when both report", () => {
    electron = true;
    nativePlatform = true;
    expect(selectSentryFlavor()).toBe(electronFlavor);
  });
});
