import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

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

const eventBus = await import("@/lib/event-bus");
const publishSpy = spyOn(eventBus, "publish");

const { publishElectronPowerSource } = await import(
  "@/runtime/event-sources/electron-power"
);

beforeEach(() => {
  activeCallback = null;
  subscribeToPowerEventsMock.mockClear();
  unsubscribeMock.mockClear();
  publishSpy.mockClear();
});

describe("publishElectronPowerSource", () => {
  test("maps every PowerEventKind onto its typed bus event", () => {
    publishElectronPowerSource();

    activeCallback!({ kind: "suspend" });
    activeCallback!({ kind: "resume" });
    activeCallback!({ kind: "lock" });
    activeCallback!({ kind: "unlock" });
    activeCallback!({ kind: "active" });

    expect(publishSpy.mock.calls).toEqual([
      ["power.suspend", {}],
      ["power.resume", {}],
      ["power.lock", {}],
      ["power.unlock", {}],
      ["power.active", {}],
    ]);
  });

  test("returns the runtime-wrapper unsubscribe so cleanup tears the bridge down", () => {
    const unsubscribe = publishElectronPowerSource();

    expect(unsubscribeMock).not.toHaveBeenCalled();
    unsubscribe();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });
});
