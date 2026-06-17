import {
  afterEach,
  beforeEach,
  describe,
  expect,
  spyOn,
  test,
} from "bun:test";

import * as eventBus from "@/lib/event-bus";
import { publishWindowOnlineSource } from "@/runtime/event-sources/window-online";

const publishSpy = spyOn(eventBus, "publish");

// Track active subscriptions so `afterEach` can remove the window
// listeners between cases — otherwise listeners from earlier tests
// fire on `dispatchEvent` in later ones and the shared `publishSpy`
// records the extra calls.
const subscriptions: Array<() => void> = [];
const trackedSubscribe = (): void => {
  subscriptions.push(publishWindowOnlineSource());
};

beforeEach(() => {
  publishSpy.mockClear();
});

afterEach(() => {
  while (subscriptions.length) subscriptions.pop()?.();
  publishSpy.mockClear();
});

describe("publishWindowOnlineSource", () => {
  test("publishes BOTH app.online and app.resume(signal:'online') on window online", () => {
    trackedSubscribe();

    window.dispatchEvent(new Event("online"));

    expect(publishSpy).toHaveBeenCalledWith("app.online", {});
    expect(publishSpy).toHaveBeenCalledWith("app.resume", {
      signal: "online",
    });
  });

  test("publishes app.offline on window offline (no resume)", () => {
    trackedSubscribe();

    window.dispatchEvent(new Event("offline"));

    expect(publishSpy).toHaveBeenCalledWith("app.offline", {});
    const resumeCalls = publishSpy.mock.calls.filter(
      ([name]) => name === "app.resume",
    );
    expect(resumeCalls).toHaveLength(0);
  });

  test("removes both listeners on unsubscribe", () => {
    const unsubscribe = publishWindowOnlineSource();
    unsubscribe();

    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("offline"));

    expect(publishSpy).not.toHaveBeenCalled();
  });
});
