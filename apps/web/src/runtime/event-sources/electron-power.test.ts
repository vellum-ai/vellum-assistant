import { beforeEach, describe, expect, mock, test } from "bun:test";

type PowerEvent = { kind: "suspend" | "resume" | "lock" | "unlock" | "active" };
let activeCallback: ((event: PowerEvent) => void) | null = null;
const unsubscribeMock = mock(() => {
  activeCallback = null;
});
const subscribeToPowerEventsMock = mock(
  (cb: (event: PowerEvent) => void) => {
    activeCallback = cb;
    return unsubscribeMock;
  },
);

mock.module("@/runtime/power-events", () => ({
  subscribeToPowerEvents: subscribeToPowerEventsMock,
}));

const { publishElectronPowerSource } = await import(
  "@/runtime/event-sources/electron-power"
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

beforeEach(() => {
  activeCallback = null;
  subscribeToPowerEventsMock.mockClear();
  unsubscribeMock.mockClear();
});

describe("publishElectronPowerSource", () => {
  test("maps every PowerEventKind onto its typed bus event", () => {
    const bus = makePublisher();
    publishElectronPowerSource(bus);

    activeCallback!({ kind: "suspend" });
    activeCallback!({ kind: "resume" });
    activeCallback!({ kind: "lock" });
    activeCallback!({ kind: "unlock" });
    activeCallback!({ kind: "active" });

    expect(bus.publish.mock.calls).toEqual([
      ["power.suspend", {}],
      ["power.resume", {}],
      ["power.lock", {}],
      ["power.unlock", {}],
      ["power.active", {}],
    ]);
  });

  test("returns the runtime-wrapper unsubscribe so cleanup tears the bridge down", () => {
    const bus = makePublisher();
    const unsubscribe = publishElectronPowerSource(bus);

    expect(unsubscribeMock).not.toHaveBeenCalled();
    unsubscribe();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });
});
