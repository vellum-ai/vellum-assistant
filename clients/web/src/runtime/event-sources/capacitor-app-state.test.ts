import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

type AppStatePayload = { isActive: boolean };
type AppStateHandler = (payload: AppStatePayload) => void;

let isNative = true;
const isNativePlatformMock = mock(() => isNative);
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: isNativePlatformMock,
}));

let activeHandler: AppStateHandler | null = null;
const handleRemoveMock = mock(async () => {});
let addListenerResolver: ((value: { remove: typeof handleRemoveMock }) => void) | null = null;
let addListenerRejecter: ((err: Error) => void) | null = null;
let pendingAddListenerPromise: Promise<{ remove: typeof handleRemoveMock }> | null =
  null;

const addListenerMock = mock(
  (_event: "appStateChange", handler: AppStateHandler) => {
    activeHandler = handler;
    pendingAddListenerPromise = new Promise<{ remove: typeof handleRemoveMock }>(
      (resolve, reject) => {
        addListenerResolver = resolve;
        addListenerRejecter = reject;
      },
    );
    return pendingAddListenerPromise;
  },
);

mock.module("@capacitor/app", () => ({
  App: {
    addListener: addListenerMock,
  },
}));

const captureExceptionMock = mock(() => {});
// Full Sentry surface — `mock.module` is process-global in bun, so a
// partial shape would shadow `addBreadcrumb` (used by other modules
// transitively loaded in this run) for every later test file. Both
// methods are kept here so the mock can satisfy any consumer that
// happens to load Sentry through our module under test.
mock.module("@sentry/browser", () => ({
  captureException: captureExceptionMock,
  addBreadcrumb: () => {},
  setContext: () => {},
}));
mock.module("@sentry/react", () => ({
  captureException: captureExceptionMock,
  addBreadcrumb: () => {},
  setContext: () => {},
}));

import * as eventBus from "@/lib/event-bus";

const publishSpy = spyOn(eventBus, "publish");

const { publishCapacitorAppStateSource } = await import(
  "@/runtime/event-sources/capacitor-app-state"
);

const flushMicrotasks = async (rounds = 4) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};
const resolveAddListener = async () => {
  // The dynamic `import("@capacitor/app")` and its `.then` chain each
  // queue a microtask, so the source's `addListenerMock` call lags
  // synchronous test code. Flush before resolving the pending promise,
  // then flush again so the `.then` that stores the `handle` runs.
  await flushMicrotasks();
  addListenerResolver?.({ remove: handleRemoveMock });
  await flushMicrotasks();
};

beforeEach(() => {
  isNative = true;
  activeHandler = null;
  addListenerResolver = null;
  addListenerRejecter = null;
  pendingAddListenerPromise = null;
  isNativePlatformMock.mockClear();
  addListenerMock.mockClear();
  handleRemoveMock.mockClear();
  captureExceptionMock.mockClear();
  publishSpy.mockClear();
});

describe("publishCapacitorAppStateSource", () => {
  test("is a no-op off Capacitor iOS (returns a no-op unsubscribe, never imports the plugin)", () => {
    isNative = false;

    const unsubscribe = publishCapacitorAppStateSource();
    unsubscribe();

    expect(addListenerMock).not.toHaveBeenCalled();
    expect(publishSpy).not.toHaveBeenCalled();
  });

  test("publishes app.resume(signal:'app_state') when isActive flips true", async () => {
    publishCapacitorAppStateSource();

    await resolveAddListener();
    activeHandler!({ isActive: true });

    expect(publishSpy).toHaveBeenCalledWith("app.resume", {
      signal: "app_state",
    });
  });

  test("publishes app.hidden(signal:'app_state') when isActive flips false", async () => {
    publishCapacitorAppStateSource();

    await resolveAddListener();
    activeHandler!({ isActive: false });

    expect(publishSpy).toHaveBeenCalledWith("app.hidden", {
      signal: "app_state",
    });
  });

  test("returned unsubscribe removes the listener once it resolves", async () => {
    const unsubscribe = publishCapacitorAppStateSource();

    await resolveAddListener();
    expect(handleRemoveMock).not.toHaveBeenCalled();

    unsubscribe();
    expect(handleRemoveMock).toHaveBeenCalledTimes(1);
  });

  test("unsubscribe BEFORE the lazy import resolves still removes the just-registered listener", async () => {
    const unsubscribe = publishCapacitorAppStateSource();

    // Unsubscribe is called first — internal `cancelled` flag must
    // catch the late `.then` and remove the listener.
    unsubscribe();
    await resolveAddListener();

    expect(handleRemoveMock).toHaveBeenCalledTimes(1);
  });

  test("reports a lazy-import failure to Sentry instead of throwing", async () => {
    publishCapacitorAppStateSource();

    await flushMicrotasks();
    const err = new Error("plugin missing");
    addListenerRejecter?.(err);
    await flushMicrotasks();

    expect(captureExceptionMock).toHaveBeenCalledWith(err, {
      level: "warning",
      tags: { context: "event_bus_capacitor_init" },
    });
  });
});
