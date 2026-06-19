import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  SessionReplayInitOptions,
  SessionReplayProvider,
  SessionReplayTraits,
} from "@/lib/session-replay/session-replay-provider";

// ---------------------------------------------------------------------------
// Provider seam — lifecycle dispatches through `provider`; init/stop flip the
// active flag so the control layer's idempotence guards are exercised.
// ---------------------------------------------------------------------------

let active = false;
const initMock = mock((_appId: string, _options: SessionReplayInitOptions) => {
  active = true;
});
const identifyMock = mock((_uid: string, _traits: SessionReplayTraits) => {});
const stopMock = mock(() => {
  active = false;
});

const provider: SessionReplayProvider = {
  init: initMock,
  identify: identifyMock,
  stop: stopMock,
  isActive: () => active,
};

mock.module("@/lib/session-replay/session-replay-provider", () => ({ provider }));

// ---------------------------------------------------------------------------
// Composed gate — reused verbatim from Sentry diagnostics consent.
// ---------------------------------------------------------------------------

let consentGranted = false;
mock.module("@/lib/sentry/consent-gate", () => ({
  diagnosticsConsentGranted: () => consentGranted,
}));

// ---------------------------------------------------------------------------
// Device settings + stores
// ---------------------------------------------------------------------------

const watchedNames: string[] = [];
let deviceWatchCallback: (() => void) | null = null;
mock.module("@/utils/device-settings", () => ({
  watchDeviceSetting: (name: string, cb: () => void) => {
    watchedNames.push(name);
    deviceWatchCallback = cb;
    return () => {
      deviceWatchCallback = null;
    };
  },
}));

interface MockUser {
  id?: string | null;
  email?: string | null;
  username?: string | null;
  firstName?: string;
  lastName?: string;
}
interface MockAuthState {
  platformSession: string;
  platformSessionRestoredOffline: boolean;
  user: MockUser | null;
}

let user: MockUser | null = null;
let authSubscriber:
  | ((state: MockAuthState, prev: MockAuthState) => void)
  | null = null;
mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    getState: () => ({ user }),
    subscribe: (cb: typeof authSubscriber) => {
      authSubscriber = cb;
      return () => {
        authSubscriber = null;
      };
    },
  },
}));

const {
  sessionReplayConsentGranted,
  syncSessionReplay,
  identifySessionReplayUser,
  installSessionReplayControlListeners,
} = await import("@/lib/session-replay/session-replay-control");

const NETWORK = {
  requestSanitizer: <T>(r: T) => r,
  responseSanitizer: <T>(r: T) => r,
  isEnabled: true,
};
const CONFIG = {
  appId: "app-123",
  surface: "web" as const,
  environment: "test",
  release: "1.2.3",
  network: NETWORK,
};

function authState(over: Partial<MockAuthState> = {}): MockAuthState {
  return {
    platformSession: "present",
    platformSessionRestoredOffline: false,
    user: { id: "u1" },
    ...over,
  };
}

beforeEach(() => {
  initMock.mockClear();
  identifyMock.mockClear();
  stopMock.mockClear();
  watchedNames.length = 0;
  deviceWatchCallback = null;
  authSubscriber = null;
  active = false;
  consentGranted = false;
  user = null;
});

describe("sessionReplayConsentGranted", () => {
  test("delegates to the Sentry diagnostics gate", () => {
    consentGranted = true;
    expect(sessionReplayConsentGranted()).toBe(true);
    consentGranted = false;
    expect(sessionReplayConsentGranted()).toBe(false);
  });
});

describe("syncSessionReplay", () => {
  test("granted + inactive: starts the provider once with surface-tagged options", () => {
    consentGranted = true;
    user = { id: "u1" };
    syncSessionReplay(CONFIG);
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(initMock.mock.calls[0]![0]).toBe("app-123");
    expect(initMock.mock.calls[0]![1]).toEqual({
      environment: "test",
      release: "1.2.3",
      surface: "web",
      network: NETWORK,
    });
    expect(stopMock).not.toHaveBeenCalled();
  });

  test("identifies the user on start", () => {
    consentGranted = true;
    user = { id: "u1", email: "user@example.com" };
    syncSessionReplay(CONFIG);
    expect(identifyMock).toHaveBeenCalledTimes(1);
    expect(identifyMock.mock.calls[0]![0]).toBe("u1");
  });

  test("does not re-init when already active", () => {
    consentGranted = true;
    active = true;
    syncSessionReplay(CONFIG);
    expect(initMock).not.toHaveBeenCalled();
  });

  test("not granted + active: stops the provider", () => {
    consentGranted = false;
    active = true;
    syncSessionReplay(CONFIG);
    expect(stopMock).toHaveBeenCalledTimes(1);
    expect(initMock).not.toHaveBeenCalled();
  });

  test("not granted + inactive: does not stop", () => {
    consentGranted = false;
    active = false;
    syncSessionReplay(CONFIG);
    expect(stopMock).not.toHaveBeenCalled();
  });
});

describe("identifySessionReplayUser", () => {
  test("builds traits from the auth store", () => {
    active = true;
    user = {
      id: "u1",
      email: "user@example.com",
      username: "alice",
      firstName: "Alice",
      lastName: "Smith",
    };
    identifySessionReplayUser("macos");
    expect(identifyMock).toHaveBeenCalledWith("u1", {
      name: "Alice Smith",
      email: "user@example.com",
      username: "alice",
      surface: "macos",
    });
  });

  test("no-op when no recording is active", () => {
    active = false;
    user = { id: "u1" };
    identifySessionReplayUser("web");
    expect(identifyMock).not.toHaveBeenCalled();
  });

  test("no-op when no user is resolved", () => {
    active = true;
    user = null;
    identifySessionReplayUser("web");
    expect(identifyMock).not.toHaveBeenCalled();
  });
});

describe("installSessionReplayControlListeners", () => {
  test("watches the diagnosticsReporting gate and re-syncs on change", () => {
    consentGranted = true;
    const stop = installSessionReplayControlListeners(CONFIG);
    expect(watchedNames).toEqual(["diagnosticsReporting"]);

    deviceWatchCallback?.();
    expect(initMock).toHaveBeenCalledTimes(1);

    stop();
  });

  test("a platform-session transition re-syncs the client", () => {
    consentGranted = true;
    const stop = installSessionReplayControlListeners(CONFIG);

    authSubscriber?.(
      authState({ platformSession: "present" }),
      authState({ platformSession: "absent" }),
    );
    expect(initMock).toHaveBeenCalledTimes(1);

    stop();
  });

  test("a user change re-identifies without re-syncing the gate", () => {
    active = true;
    user = { id: "u2" };
    const stop = installSessionReplayControlListeners(CONFIG);

    authSubscriber?.(
      authState({ user: { id: "u2" } }),
      authState({ user: { id: "u1" } }),
    );
    expect(identifyMock).toHaveBeenCalledTimes(1);
    expect(identifyMock.mock.calls[0]![0]).toBe("u2");
    expect(initMock).not.toHaveBeenCalled();
    expect(stopMock).not.toHaveBeenCalled();

    stop();
  });

  test("cleanup removes both the device watch and the auth subscription", () => {
    const stop = installSessionReplayControlListeners(CONFIG);
    expect(deviceWatchCallback).not.toBeNull();
    expect(authSubscriber).not.toBeNull();
    stop();
    expect(deviceWatchCallback).toBeNull();
    expect(authSubscriber).toBeNull();
  });
});
