import { afterEach, describe, expect, mock, test } from "bun:test";

let nativePlatform = false;
let electron = false;

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => nativePlatform,
}));
mock.module("@/runtime/is-electron", () => ({ isElectron: () => electron }));
// flavor-capacitor's beforeSend reads the composed gate; stub it so importing
// the capacitor flavor here does not drag in the auth store's runtime deps.
mock.module("@/lib/sentry/consent-gate", () => ({
  diagnosticsConsentGranted: () => false,
}));

const { selectSentryFlavor } = await import("@/lib/sentry/flavor");
const { reactFlavor } = await import("@/lib/sentry/flavor-react");
const { capacitorFlavor } = await import("@/lib/sentry/flavor-capacitor");

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

  test("selects the react flavor in the Electron renderer", () => {
    electron = true;
    expect(selectSentryFlavor()).toBe(reactFlavor);
  });

  test("prefers the react flavor over capacitor in the Electron renderer", () => {
    electron = true;
    nativePlatform = true;
    expect(selectSentryFlavor()).toBe(reactFlavor);
  });
});
