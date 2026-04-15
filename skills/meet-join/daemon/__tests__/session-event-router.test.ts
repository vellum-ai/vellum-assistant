/**
 * Unit tests for the per-meeting event router consumed by the meet ingress
 * route and downstream subscribers.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type { MeetBotEvent } from "@vellumai/meet-contracts";

import {
  __resetMeetSessionEventRouterForTests,
  getMeetSessionEventRouter,
  MeetSessionEventRouter,
  setBotApiTokenResolver,
} from "../session-event-router.js";

function makeLifecycleEvent(
  meetingId: string,
  state: "joining" | "joined" | "leaving" | "left" | "error" = "joined",
): MeetBotEvent {
  return {
    type: "lifecycle",
    meetingId,
    timestamp: new Date(0).toISOString(),
    state,
  };
}

describe("MeetSessionEventRouter", () => {
  let router: MeetSessionEventRouter;

  beforeEach(() => {
    router = new MeetSessionEventRouter();
  });

  test("register → dispatch → handler fires", () => {
    const received: MeetBotEvent[] = [];
    router.register("m1", (event) => received.push(event));

    const event = makeLifecycleEvent("m1");
    router.dispatch("m1", event);

    expect(received).toEqual([event]);
    expect(router.registeredCount()).toBe(1);
  });

  test("unregister → dispatch → no-op (log only)", () => {
    const received: MeetBotEvent[] = [];
    router.register("m1", (event) => received.push(event));
    router.unregister("m1");

    router.dispatch("m1", makeLifecycleEvent("m1"));

    expect(received).toEqual([]);
    expect(router.registeredCount()).toBe(0);
  });

  test("dispatch to unregistered meeting is a no-op", () => {
    // No registration at all — must not throw.
    router.dispatch("never-registered", makeLifecycleEvent("never-registered"));
  });

  test("multiple meetings have independent handlers (no cross-talk)", () => {
    const m1Events: MeetBotEvent[] = [];
    const m2Events: MeetBotEvent[] = [];
    router.register("m1", (event) => m1Events.push(event));
    router.register("m2", (event) => m2Events.push(event));

    const e1 = makeLifecycleEvent("m1", "joining");
    const e2 = makeLifecycleEvent("m2", "joined");
    const e3 = makeLifecycleEvent("m1", "leaving");

    router.dispatch("m1", e1);
    router.dispatch("m2", e2);
    router.dispatch("m1", e3);

    expect(m1Events).toEqual([e1, e3]);
    expect(m2Events).toEqual([e2]);
    expect(router.registeredCount()).toBe(2);
  });

  test("re-register replaces the prior handler for the same meetingId", () => {
    const firstEvents: MeetBotEvent[] = [];
    const secondEvents: MeetBotEvent[] = [];

    router.register("m1", (event) => firstEvents.push(event));
    router.register("m1", (event) => secondEvents.push(event));

    const event = makeLifecycleEvent("m1");
    router.dispatch("m1", event);

    expect(firstEvents).toEqual([]);
    expect(secondEvents).toEqual([event]);
    expect(router.registeredCount()).toBe(1);
  });

  test("a thrown handler does not poison the router", () => {
    router.register("m1", () => {
      throw new Error("boom");
    });

    const m2Events: MeetBotEvent[] = [];
    router.register("m2", (event) => m2Events.push(event));

    // Dispatch to the throwing handler first — must not propagate.
    router.dispatch("m1", makeLifecycleEvent("m1"));

    const event = makeLifecycleEvent("m2");
    router.dispatch("m2", event);
    expect(m2Events).toEqual([event]);
  });

  test("default bot api token resolver rejects all", () => {
    expect(router.resolveBotApiToken("anything")).toBeNull();
  });

  test("installed bot api token resolver is consulted", () => {
    router.setBotApiTokenResolver((id) => (id === "m1" ? "tok-1" : null));

    expect(router.resolveBotApiToken("m1")).toBe("tok-1");
    expect(router.resolveBotApiToken("m2")).toBeNull();
  });
});

describe("MeetSessionEventRouter singleton + setBotApiTokenResolver export", () => {
  beforeEach(() => {
    __resetMeetSessionEventRouterForTests();
  });

  test("getMeetSessionEventRouter returns the same instance", () => {
    const a = getMeetSessionEventRouter();
    const b = getMeetSessionEventRouter();
    expect(a).toBe(b);
  });

  test("__resetMeetSessionEventRouterForTests produces a fresh singleton", () => {
    const a = getMeetSessionEventRouter();
    __resetMeetSessionEventRouterForTests();
    const b = getMeetSessionEventRouter();
    expect(a).not.toBe(b);
  });

  test("setBotApiTokenResolver installs resolver on the singleton", () => {
    setBotApiTokenResolver((id) => (id === "live" ? "tok" : null));
    expect(getMeetSessionEventRouter().resolveBotApiToken("live")).toBe("tok");
    expect(getMeetSessionEventRouter().resolveBotApiToken("dead")).toBeNull();
  });
});
