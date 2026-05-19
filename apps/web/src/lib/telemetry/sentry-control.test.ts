/**
 * Tests for the browser-Sentry gate.
 *
 * `@sentry/react` is mocked so we can observe init/close calls without
 * actually booting a Sentry client in the bun test worker. The module
 * under test is dynamic-imported inside each test to pick up the mock.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

// ---------------------------------------------------------------------------
// Sentry mock — `getClient`, `init`, `close` all observable.
// ---------------------------------------------------------------------------

interface FakeClient {
  enabled: boolean;
  close: (timeoutMs?: number) => Promise<boolean>;
  getOptions: () => { enabled: boolean };
}

// Matches Sentry v10's real behavior: `client.close()` flushes + disables
// the client but does NOT unbind it from the current scope. `getClient()`
// keeps returning the (now-disabled) client until something calls
// `scope.setClient(undefined)`. The production code under test handles
// this by explicitly unbinding after close, and this mock reflects that
// contract so the "close followed by re-init" test can catch regressions.
let currentClient: FakeClient | null = null;

function makeClient(): FakeClient {
  const client: FakeClient = {
    enabled: true,
    close: async () => {
      client.enabled = false;
      return true;
    },
    getOptions: () => ({ enabled: client.enabled }),
  };
  return client;
}

const initMock = mock(() => {
  currentClient = makeClient();
});
const getClientMock = mock(() => currentClient);
const setClientMock = mock((next: FakeClient | undefined) => {
  currentClient = next ?? null;
});
const getCurrentScopeMock = mock(() => ({ setClient: setClientMock }));

// `mock.module` in bun persists across test files within the same run,
// so this stub needs to cover every method other modules import from
// `@sentry/react` — otherwise a later test whose subject code touches
// `captureException` / `captureMessage` (e.g. `@/domains/chat/lib/api`) crashes
// with a "not a function" TypeError once it resolves this shim instead
// of the real SDK.
mock.module("@sentry/react", () => ({
  init: initMock,
  getClient: getClientMock,
  getCurrentScope: getCurrentScopeMock,
  captureException: () => {},
  captureMessage: () => {},
}));

// ---------------------------------------------------------------------------
// localStorage + window shim (bun test has no DOM by default).
// ---------------------------------------------------------------------------

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

// bun:test doesn't provide `StorageEvent` globally — shim the fields we
// actually read (`key`, `newValue`). Mirrors the pattern in
// `lib/onboarding/prefs.test.ts`.
class FakeStorageEvent extends Event {
  key: string | null;
  newValue: string | null;
  constructor(
    type: string,
    init: { key?: string | null; newValue?: string | null } = {},
  ) {
    super(type);
    this.key = init.key ?? null;
    this.newValue = init.newValue ?? null;
  }
}
const StorageEventCtor: typeof StorageEvent =
  (globalThis as { StorageEvent?: typeof StorageEvent }).StorageEvent ??
  (FakeStorageEvent as unknown as typeof StorageEvent);

const memoryStorage = new MemoryStorage();
const listeners = new Map<string, Set<EventListener>>();
const fakeWindow = {
  localStorage: memoryStorage,
  addEventListener: (type: string, listener: EventListener) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(listener);
  },
  removeEventListener: (type: string, listener: EventListener) => {
    listeners.get(type)?.delete(listener);
  },
  dispatchEvent: (event: Event) => {
    const set = listeners.get(event.type);
    set?.forEach((l) => l(event));
    return true;
  },
};

const ORIGINAL_WINDOW = Object.getOwnPropertyDescriptor(globalThis, "window");
const ORIGINAL_LOCAL_STORAGE = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);

beforeAll(() => {
  Object.defineProperty(globalThis, "window", {
    value: fakeWindow,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, "localStorage", {
    value: memoryStorage,
    configurable: true,
    writable: true,
  });
});

afterAll(() => {
  if (ORIGINAL_WINDOW) {
    Object.defineProperty(globalThis, "window", ORIGINAL_WINDOW);
  } else {
    delete (globalThis as { window?: unknown }).window;
  }
  if (ORIGINAL_LOCAL_STORAGE) {
    Object.defineProperty(globalThis, "localStorage", ORIGINAL_LOCAL_STORAGE);
  } else {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

beforeEach(() => {
  memoryStorage.clear();
  listeners.clear();
  currentClient = null;
  initMock.mockClear();
  getClientMock.mockClear();
  setClientMock.mockClear();
});

afterEach(() => {
  memoryStorage.clear();
  listeners.clear();
});

// ---------------------------------------------------------------------------
// Subject under test
// ---------------------------------------------------------------------------

const OPTS = {
  dsn: "https://example@ingest.sentry.io/1234",
  environment: "test",
};

describe("syncSentryClient", () => {
  test("no-op when dsn is absent (no init, no close)", async () => {
    const { syncSentryClient } = await import("./sentry-control");
    memoryStorage.setItem("vellum_share_diagnostics", "true");
    syncSentryClient({});
    expect(initMock).toHaveBeenCalledTimes(0);
  });

  test("does not init when consent is absent (strict opt-in)", async () => {
    const { syncSentryClient } = await import("./sentry-control");
    syncSentryClient(OPTS);
    expect(initMock).toHaveBeenCalledTimes(0);
    expect(currentClient).toBeNull();
  });

  test("does not init when consent is explicit false", async () => {
    const { syncSentryClient } = await import("./sentry-control");
    memoryStorage.setItem("vellum_share_diagnostics", "false");
    syncSentryClient(OPTS);
    expect(initMock).toHaveBeenCalledTimes(0);
  });

  test("inits when consent is explicit true", async () => {
    const { syncSentryClient } = await import("./sentry-control");
    memoryStorage.setItem("vellum_share_diagnostics", "true");
    syncSentryClient(OPTS);
    expect(initMock).toHaveBeenCalledTimes(1);
    expect(currentClient).not.toBeNull();
  });

  test("idempotent when already running + consent still true", async () => {
    const { syncSentryClient } = await import("./sentry-control");
    memoryStorage.setItem("vellum_share_diagnostics", "true");
    syncSentryClient(OPTS);
    syncSentryClient(OPTS);
    expect(initMock).toHaveBeenCalledTimes(1);
  });

  test("closes a running client when consent flips to false", async () => {
    const { syncSentryClient } = await import("./sentry-control");
    memoryStorage.setItem("vellum_share_diagnostics", "true");
    syncSentryClient(OPTS);
    expect(currentClient).not.toBeNull();
    memoryStorage.setItem("vellum_share_diagnostics", "false");
    syncSentryClient(OPTS);
    // The production code unbinds the client from the current scope after
    // closing it, so `getClient()` returns null on next inspection.
    expect(setClientMock).toHaveBeenCalledWith(undefined);
    expect(currentClient).toBeNull();
  });

  test("re-inits after a previous close (regression: closed client mustn't block re-init)", async () => {
    const { syncSentryClient } = await import("./sentry-control");
    // Opt in → init runs.
    memoryStorage.setItem("vellum_share_diagnostics", "true");
    syncSentryClient(OPTS);
    expect(initMock).toHaveBeenCalledTimes(1);
    // Opt out → close + unbind.
    memoryStorage.setItem("vellum_share_diagnostics", "false");
    syncSentryClient(OPTS);
    // Opt back in → init must run again. (Before the unbind fix, the
    // now-disabled-but-still-bound client would short-circuit `tryInit`
    // and Sentry would stay off forever.)
    memoryStorage.setItem("vellum_share_diagnostics", "true");
    syncSentryClient(OPTS);
    expect(initMock).toHaveBeenCalledTimes(2);
    expect(currentClient?.enabled).toBe(true);
  });
});

describe("installSentryControlListeners", () => {
  test("reacts to cross-tab storage events for the diagnostics key", async () => {
    const { installSentryControlListeners } = await import("./sentry-control");
    installSentryControlListeners(OPTS);
    // Simulate a storage event (another tab flipped the toggle to true).
    memoryStorage.setItem("vellum_share_diagnostics", "true");
    fakeWindow.dispatchEvent(
      new StorageEventCtor("storage", {
        key: "vellum_share_diagnostics",
        newValue: "true",
      }),
    );
    expect(initMock).toHaveBeenCalledTimes(1);
  });

  test("ignores storage events for unrelated keys", async () => {
    const { installSentryControlListeners } = await import("./sentry-control");
    installSentryControlListeners(OPTS);
    memoryStorage.setItem("vellum_share_diagnostics", "true");
    fakeWindow.dispatchEvent(
      new StorageEventCtor("storage", { key: "some_other_key", newValue: "true" }),
    );
    expect(initMock).toHaveBeenCalledTimes(0);
  });

  test("reacts to same-tab custom events for the diagnostics key", async () => {
    const { installSentryControlListeners } = await import("./sentry-control");
    installSentryControlListeners(OPTS);
    memoryStorage.setItem("vellum_share_diagnostics", "true");
    fakeWindow.dispatchEvent(
      new CustomEvent("vellum:pref-changed", {
        detail: { key: "vellum_share_diagnostics", value: "true" },
      }),
    );
    expect(initMock).toHaveBeenCalledTimes(1);
  });

  test("ignores custom events for unrelated keys", async () => {
    const { installSentryControlListeners } = await import("./sentry-control");
    installSentryControlListeners(OPTS);
    memoryStorage.setItem("vellum_share_diagnostics", "true");
    fakeWindow.dispatchEvent(
      new CustomEvent("vellum:pref-changed", {
        detail: { key: "vellum_share_analytics", value: "false" },
      }),
    );
    expect(initMock).toHaveBeenCalledTimes(0);
  });

  test("cleanup removes both listeners", async () => {
    const { installSentryControlListeners } = await import("./sentry-control");
    const dispose = installSentryControlListeners(OPTS);
    dispose();
    memoryStorage.setItem("vellum_share_diagnostics", "true");
    fakeWindow.dispatchEvent(
      new StorageEventCtor("storage", {
        key: "vellum_share_diagnostics",
        newValue: "true",
      }),
    );
    fakeWindow.dispatchEvent(
      new CustomEvent("vellum:pref-changed", {
        detail: { key: "vellum_share_diagnostics", value: "true" },
      }),
    );
    expect(initMock).toHaveBeenCalledTimes(0);
  });
});
