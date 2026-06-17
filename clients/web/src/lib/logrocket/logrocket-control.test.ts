import { beforeEach, describe, expect, mock, test } from "bun:test";

// LogRocket SDK — capture init/identify calls without loading the real SDK.
const initMock = mock((_appId: string, _options: unknown) => {});
const identifyMock = mock((_uid: string) => {});
mock.module("logrocket", () => ({
  default: { init: initMock, identify: identifyMock },
}));

// Consent inputs: the device toggle and the onboarding store's
// version-accepted flags. Driven per-test.
let toggleOn = false;
let storeState = { tosAccepted: false, aiDataConsent: false };
const watchers: Array<() => void> = [];
const storeSubscribers: Array<() => void> = [];

mock.module("@/utils/device-settings", () => ({
  getDeviceBool: (_name: string, fallback: boolean) =>
    _name === "shareProductImprovement" ? toggleOn : fallback,
  watchDeviceSetting: (_name: string, cb: () => void) => {
    watchers.push(cb);
    return () => {};
  },
}));

mock.module("@/domains/onboarding/onboarding-store", () => ({
  useOnboardingStore: {
    getState: () => storeState,
    subscribe: (cb: () => void) => {
      storeSubscribers.push(cb);
      return () => {};
    },
  },
}));

let userId: string | null = null;
mock.module("@/stores/auth-store", () => ({
  useAuthStore: { getState: () => ({ user: userId ? { id: userId } : null }) },
}));

const {
  logRocketConsentGranted,
  syncLogRocketClient,
  installLogRocketControlListeners,
} = await import("@/lib/logrocket/logrocket-control");

const APP_ID = "org/app";
const OPTIONS = {} as Parameters<typeof syncLogRocketClient>[1];

beforeEach(() => {
  initMock.mockClear();
  identifyMock.mockClear();
  toggleOn = false;
  storeState = { tosAccepted: false, aiDataConsent: false };
  userId = null;
  watchers.length = 0;
  storeSubscribers.length = 0;
});

describe("logRocketConsentGranted", () => {
  test("requires both the toggle and current-version acceptance", () => {
    toggleOn = false;
    storeState = { tosAccepted: true, aiDataConsent: true };
    expect(logRocketConsentGranted()).toBe(false);

    toggleOn = true;
    storeState = { tosAccepted: false, aiDataConsent: false };
    expect(logRocketConsentGranted()).toBe(false);

    // tos accepted but AI consent missing — still not the current version.
    storeState = { tosAccepted: true, aiDataConsent: false };
    expect(logRocketConsentGranted()).toBe(false);

    storeState = { tosAccepted: true, aiDataConsent: true };
    expect(logRocketConsentGranted()).toBe(true);
  });
});

// The control module holds a one-time `initialized` flag (the LogRocket SDK
// has no re-init/teardown). It is not resettable between tests, so the full
// init lifecycle is asserted in a single ordered test rather than split
// across cases that would each need a fresh flag.
describe("syncLogRocketClient + listeners (init lifecycle)", () => {
  test("gates the one-time init on consent, then initializes lazily on opt-in", () => {
    // No app id → no-op even with consent.
    toggleOn = true;
    storeState = { tosAccepted: true, aiDataConsent: true };
    syncLogRocketClient("", OPTIONS);
    expect(initMock).not.toHaveBeenCalled();

    // App id present but consent withdrawn → still no init.
    toggleOn = false;
    syncLogRocketClient(APP_ID, OPTIONS);
    expect(initMock).not.toHaveBeenCalled();

    // Listeners installed while consent is absent — nothing initializes yet.
    installLogRocketControlListeners(APP_ID, OPTIONS);
    expect(initMock).not.toHaveBeenCalled();
    expect(watchers.length).toBe(1);
    expect(storeSubscribers.length).toBe(1);

    // User opts in (toggle on AND current version accepted) and the watcher
    // fires → lazy one-time init + identify.
    toggleOn = true;
    storeState = { tosAccepted: true, aiDataConsent: true };
    userId = "user-1";
    watchers[0]!();
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock).toHaveBeenCalledWith(APP_ID, OPTIONS);
    expect(identifyMock).toHaveBeenCalledWith("user-1");

    // Idempotent — further syncs must not re-init or re-identify.
    syncLogRocketClient(APP_ID, OPTIONS);
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(identifyMock).toHaveBeenCalledTimes(1);
  });
});
