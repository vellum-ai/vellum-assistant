import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import * as eventBus from "@/lib/event-bus";
import { publishVisibilitySource } from "@/runtime/event-sources/dom-visibility";

const publishSpy = spyOn(eventBus, "publish");

// Track active subscriptions so `afterEach` can remove the
// document listeners between cases — otherwise listeners from
// earlier tests fire on `dispatchEvent` in later ones and the
// shared `publishSpy` records the extra calls.
const subscriptions: Array<() => void> = [];
const trackedSubscribe = (): void => {
  subscriptions.push(publishVisibilitySource());
};

beforeEach(() => {
  publishSpy.mockClear();
});

afterEach(() => {
  while (subscriptions.length) subscriptions.pop()?.();
  publishSpy.mockClear();
});

const setVisibility = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
};

describe("publishVisibilitySource", () => {
  test("publishes app.hidden(signal:'visibility') when document becomes hidden", () => {
    setVisibility("visible");
    trackedSubscribe();

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(publishSpy).toHaveBeenCalledWith("app.hidden", {
      signal: "visibility",
    });
  });

  test("publishes app.resume(signal:'visibility') when document becomes visible", () => {
    setVisibility("hidden");
    trackedSubscribe();

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(publishSpy).toHaveBeenCalledWith("app.resume", {
      signal: "visibility",
    });
  });

  test("removes the listener on unsubscribe", () => {
    setVisibility("visible");
    const unsubscribe = publishVisibilitySource();
    unsubscribe();

    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(publishSpy).not.toHaveBeenCalled();
  });
});
