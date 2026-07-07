import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

type AppStatePayload = { isActive: boolean };
type AppStateHandler = (payload: AppStatePayload) => void;

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => true,
}));

let activeHandler: AppStateHandler | null = null;
const addListenerMock = mock(
  (_event: "appStateChange", handler: AppStateHandler) => {
    activeHandler = handler;
    return Promise.resolve({ remove: async () => {} });
  },
);

mock.module("@capacitor/app", () => ({
  App: {
    addListener: addListenerMock,
  },
}));

// Warm the module cache so the source's lazy `import("@capacitor/app")`
// resolves within microtasks instead of a full loader turn.
await import("@capacitor/app");

const captureErrorMock = mock(() => {});
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorMock,
}));

import * as eventBus from "@/lib/event-bus";

const publishSpy = spyOn(eventBus, "publish");

const { publishCapacitorAppStateSource } =
  await import("@/runtime/event-sources/capacitor-app-state");

// The dynamic `import("@capacitor/app")` and its `.then` chain each
// queue a microtask, so listener registration lags synchronous test
// code — flush before driving the captured handler.
const flushMicrotasks = async (rounds = 4) => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
};

beforeEach(() => {
  activeHandler = null;
  addListenerMock.mockClear();
  captureErrorMock.mockClear();
  publishSpy.mockClear();
});

// The platform guard, unsubscribe races, and failure reporting are the
// `subscribeCapacitorListener` contract, covered by
// `runtime/capacitor-listener.test.ts`. This suite covers only this
// source's wiring: what it publishes and its error context.
describe("publishCapacitorAppStateSource", () => {
  test("publishes app.resume(signal:'app_state') when isActive flips true", async () => {
    publishCapacitorAppStateSource();
    await flushMicrotasks();

    activeHandler!({ isActive: true });

    expect(publishSpy).toHaveBeenCalledWith("app.resume", {
      signal: "app_state",
    });
  });

  test("publishes app.hidden(signal:'app_state') when isActive flips false", async () => {
    publishCapacitorAppStateSource();
    await flushMicrotasks();

    activeHandler!({ isActive: false });

    expect(publishSpy).toHaveBeenCalledWith("app.hidden", {
      signal: "app_state",
    });
  });

  test("reports listener-registration failures under the 'event_bus_capacitor_init' context", async () => {
    const err = new Error("plugin missing");
    addListenerMock.mockImplementationOnce(() => Promise.reject(err));

    publishCapacitorAppStateSource();
    await flushMicrotasks();

    expect(captureErrorMock).toHaveBeenCalledWith(err, {
      context: "event_bus_capacitor_init",
      level: "warning",
    });
  });
});
