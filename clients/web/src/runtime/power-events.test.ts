/**
 * The Electron platform check is mocked so the wrapper runs without a desktop
 * host. The contract under test is the off-Electron half: a browser tab and
 * the Capacitor shell never see a system power event, which is what lets
 * consumers of `power.lock` / `power.suspend` treat those as desktop-only
 * without an `isElectron()` guard of their own.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let runningInElectron = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => runningInElectron,
}));

const { subscribeToPowerEvents } = await import("@/runtime/power-events");

beforeEach(() => {
  runningInElectron = false;
});

afterEach(() => {
  runningInElectron = false;
  delete (window as { vellum?: unknown }).vellum;
});

describe("subscribeToPowerEvents", () => {
  test("never calls back off Electron, even with a host bridge present", () => {
    const onEvent = mock(() => () => undefined);
    (window as { vellum?: unknown }).vellum = { power: { onEvent } };

    const unsubscribe = subscribeToPowerEvents(() => {
      throw new Error("no power event may reach a browser tab");
    });

    expect(onEvent).not.toHaveBeenCalled();
    expect(() => {
      unsubscribe();
    }).not.toThrow();
  });

  test("subscribes to the host bridge on Electron", () => {
    runningInElectron = true;
    const hostUnsubscribe = mock(() => undefined);
    const onEvent = mock(() => hostUnsubscribe);
    (window as { vellum?: unknown }).vellum = { power: { onEvent } };

    const unsubscribe = subscribeToPowerEvents(() => undefined);

    expect(onEvent).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(hostUnsubscribe).toHaveBeenCalledTimes(1);
  });
});
