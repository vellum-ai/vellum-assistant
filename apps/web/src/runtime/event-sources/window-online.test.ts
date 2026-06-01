import { describe, expect, mock, test } from "bun:test";

import { publishWindowOnlineSource } from "@/runtime/event-sources/window-online";
import type {
  BusEventName,
  BusEventPayload,
} from "@/stores/event-bus-store";

const makePublisher = () => ({
  publish: mock(
    <K extends BusEventName>(_event: K, _payload: BusEventPayload<K>) => {},
  ),
});

describe("publishWindowOnlineSource", () => {
  test("publishes BOTH app.online and app.resume(signal:'online') on window online", () => {
    const bus = makePublisher();
    const unsubscribe = publishWindowOnlineSource(bus);

    window.dispatchEvent(new Event("online"));

    expect(bus.publish).toHaveBeenCalledWith("app.online", {});
    expect(bus.publish).toHaveBeenCalledWith("app.resume", {
      signal: "online",
    });
    unsubscribe();
  });

  test("publishes app.offline on window offline (no resume)", () => {
    const bus = makePublisher();
    const unsubscribe = publishWindowOnlineSource(bus);

    window.dispatchEvent(new Event("offline"));

    expect(bus.publish).toHaveBeenCalledWith("app.offline", {});
    const resumeCalls = bus.publish.mock.calls.filter(
      ([name]) => name === "app.resume",
    );
    expect(resumeCalls).toHaveLength(0);
    unsubscribe();
  });

  test("removes both listeners on unsubscribe", () => {
    const bus = makePublisher();
    const unsubscribe = publishWindowOnlineSource(bus);
    unsubscribe();

    window.dispatchEvent(new Event("online"));
    window.dispatchEvent(new Event("offline"));

    expect(bus.publish).not.toHaveBeenCalled();
  });
});
