import { afterEach, describe, expect, mock, test } from "bun:test";

import { publishVisibilitySource } from "@/runtime/event-sources/dom-visibility";
import type {
  BusEventName,
  BusEventPayload,
} from "@/stores/event-bus-store";

const makePublisher = () => ({
  publish: mock(
    <K extends BusEventName>(_event: K, _payload: BusEventPayload<K>) => {},
  ),
});

const setVisibilityState = (state: "visible" | "hidden") => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
};

afterEach(() => {
  setVisibilityState("visible");
});

describe("publishVisibilitySource", () => {
  test("publishes app.hidden(signal:'visibility') when document becomes hidden", () => {
    const bus = makePublisher();
    const unsubscribe = publishVisibilitySource(bus);

    setVisibilityState("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(bus.publish).toHaveBeenCalledWith("app.hidden", {
      signal: "visibility",
    });
    unsubscribe();
  });

  test("publishes app.resume(signal:'visibility') when document becomes visible", () => {
    const bus = makePublisher();
    const unsubscribe = publishVisibilitySource(bus);

    setVisibilityState("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(bus.publish).toHaveBeenCalledWith("app.resume", {
      signal: "visibility",
    });
    unsubscribe();
  });

  test("removes the listener on unsubscribe", () => {
    const bus = makePublisher();
    const unsubscribe = publishVisibilitySource(bus);
    unsubscribe();

    setVisibilityState("hidden");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(bus.publish).not.toHaveBeenCalled();
  });
});
