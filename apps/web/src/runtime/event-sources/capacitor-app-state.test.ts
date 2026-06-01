import { beforeEach, describe, expect, mock, test } from "bun:test";

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
mock.module("@sentry/browser", () => ({
  captureException: captureExceptionMock,
}));

const { publishCapacitorAppStateSource } = await import(
  "@/runtime/event-sources/capacitor-app-state"
);
import type {
  BusEventName,
  BusEventPayload,
} from "@/stores/event-bus-store";

const makePublisher = () => ({
  publish: mock(
    <K extends BusEventName>(_event: K, _payload: BusEventPayload<K>) => {},
  ),
});
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
});

describe("publishCapacitorAppStateSource", () => {
  test("is a no-op off Capacitor iOS (returns a no-op unsubscribe, never imports the plugin)", () => {
    isNative = false;
    const bus = makePublisher();

    const unsubscribe = publishCapacitorAppStateSource(bus);
    unsubscribe();

    expect(addListenerMock).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  test("publishes app.resume(signal:'app_state') when isActive flips true", async () => {
    const bus = makePublisher();
    publishCapacitorAppStateSource(bus);

    await resolveAddListener();
    activeHandler!({ isActive: true });

    expect(bus.publish).toHaveBeenCalledWith("app.resume", {
      signal: "app_state",
    });
  });

  test("publishes app.hidden(signal:'app_state') when isActive flips false", async () => {
    const bus = makePublisher();
    publishCapacitorAppStateSource(bus);

    await resolveAddListener();
    activeHandler!({ isActive: false });

    expect(bus.publish).toHaveBeenCalledWith("app.hidden", {
      signal: "app_state",
    });
  });

  test("returned unsubscribe removes the listener once it resolves", async () => {
    const unsubscribe = publishCapacitorAppStateSource(makePublisher());

    await resolveAddListener();
    expect(handleRemoveMock).not.toHaveBeenCalled();

    unsubscribe();
    expect(handleRemoveMock).toHaveBeenCalledTimes(1);
  });

  test("unsubscribe BEFORE the lazy import resolves still removes the just-registered listener", async () => {
    const unsubscribe = publishCapacitorAppStateSource(makePublisher());

    // Unsubscribe is called first — internal `cancelled` flag must
    // catch the late `.then` and remove the listener.
    unsubscribe();
    await resolveAddListener();

    expect(handleRemoveMock).toHaveBeenCalledTimes(1);
  });

  test("reports a lazy-import failure to Sentry instead of throwing", async () => {
    publishCapacitorAppStateSource(makePublisher());

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
