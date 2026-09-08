import { expect, mock, test } from "bun:test";

const listeners = new Map<string, (...args: unknown[]) => void>();
const send = mock((_channel: string, ..._args: unknown[]) => undefined);
const invoke = mock((channel: string) =>
  Promise.resolve(channel === "vellum:connectivity:get" ? "online" : null),
);
const off = mock(() => undefined);

mock.module("electron", () => ({
  ipcRenderer: {
    invoke,
    off,
    on: (channel: string, listener: (...args: unknown[]) => void) => {
      listeners.set(channel, listener);
    },
    send,
  },
}));

const presence = (await import("./features/presence")).default;

type FakeCapability = Record<string, (...args: unknown[]) => unknown>;

test("contributes the complete presence bridge", () => {
  const contributions = new Map<string, unknown>();
  presence.install({
    contribute: (key: string, value: unknown) => contributions.set(key, value),
  } as never);

  expect([...contributions.keys()].sort()).toEqual([
    "connectivity",
    "dock",
    "featureFlags",
    "icon",
    "identity",
    "power",
    "status",
  ]);
});

test("publishes flags, status, identity, avatar, and unread state", () => {
  const contributions = new Map<string, FakeCapability>();
  presence.install({
    contribute: (key: string, value: unknown) =>
      contributions.set(key, value as FakeCapability),
  } as never);

  contributions.get("featureFlags")?.set({ sounds: true });
  contributions.get("status")?.setConnection("thinking");
  contributions.get("identity")?.setName("Example Assistant");
  contributions.get("icon")?.setAvatar(null);
  contributions.get("icon")?.setCharacter(null);
  contributions.get("dock")?.setBadge(3);

  expect(send.mock.calls.map((call) => call[0])).toEqual([
    "vellum:featureFlags:set",
    "vellum:status:connection",
    "vellum:identity:name",
    "vellum:icon:setAvatar",
    "vellum:icon:setCharacter",
    "vellum:dock:setBadge",
  ]);
});

test("delivers power and current connectivity state with cleanup", async () => {
  const contributions = new Map<string, FakeCapability>();
  presence.install({
    contribute: (key: string, value: unknown) =>
      contributions.set(key, value as FakeCapability),
  } as never);
  const powerEvents: unknown[] = [];
  const states: unknown[] = [];

  const stopPower = contributions
    .get("power")
    ?.onEvent((event: unknown) => powerEvents.push(event)) as () => void;
  const stopConnectivity = contributions
    .get("connectivity")
    ?.onState((state: unknown) => states.push(state)) as () => void;
  listeners.get("vellum:power:event")?.({}, { kind: "resume" });
  await Promise.resolve();
  stopPower();
  stopConnectivity();

  expect(powerEvents).toEqual([{ kind: "resume" }]);
  expect(states).toEqual(["online"]);
  expect(off).toHaveBeenCalledTimes(2);
});
