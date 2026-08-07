/**
 * Tests for the retrying SSE actor-principal self-heal.
 *
 * The invariant they pin: a single empty or failed guardian lookup must not
 * strand the subscription without a principal. The read goes over the gateway
 * IPC and comes back empty both when the transport fails and when no binding
 * exists yet, and a subscription that stays principal-less rejects every
 * host-proxy result its client submits with "Submitting actor does not match
 * the target client's actor for this request" until it reconnects.
 */
import { describe, expect, mock, test } from "bun:test";

import { startActorPrincipalHeal } from "../sse-actor-principal-heal.js";

/** All-zero schedule so the retries run without real wall-clock delay. */
const NO_DELAYS = [0, 0, 0];

/** Minimal hub double: `needs` flips to false once a principal is filled. */
function fakeHub(options?: { needs?: boolean }) {
  let needs = options?.needs ?? true;
  const filled: string[] = [];
  return {
    filled,
    setNeeds(value: boolean) {
      needs = value;
    },
    needsActorPrincipalHeal: mock(() => needs),
    fillClientActorPrincipalId: mock((_connectionId: string, id: string) => {
      filled.push(id);
      needs = false;
    }),
  };
}

/** Let the heal's async loop run to completion. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("startActorPrincipalHeal", () => {
  test("fills the principal on the first successful attempt", async () => {
    const hub = fakeHub();
    startActorPrincipalHeal({
      hub,
      connectionId: "conn-1",
      resolve: () => Promise.resolve("guardian-real-id"),
      delaysMs: NO_DELAYS,
    });
    await settle();

    expect(hub.filled).toEqual(["guardian-real-id"]);
    expect(hub.needsActorPrincipalHeal).toHaveBeenCalledTimes(1);
  });

  test("retries after a lookup that resolves undefined (gateway unreachable)", async () => {
    const hub = fakeHub();
    let calls = 0;
    startActorPrincipalHeal({
      hub,
      connectionId: "conn-1",
      resolve: () => {
        calls++;
        // Two failed reads, then the gateway comes up.
        return Promise.resolve(calls < 3 ? undefined : "guardian-real-id");
      },
      delaysMs: NO_DELAYS,
    });
    await settle();

    expect(calls).toBe(3);
    expect(hub.filled).toEqual(["guardian-real-id"]);
  });

  test("retries after a lookup that rejects", async () => {
    const hub = fakeHub();
    let calls = 0;
    startActorPrincipalHeal({
      hub,
      connectionId: "conn-1",
      resolve: () => {
        calls++;
        return calls === 1
          ? Promise.reject(new Error("ipc timeout"))
          : Promise.resolve("guardian-real-id");
      },
      delaysMs: NO_DELAYS,
    });
    await settle();

    expect(calls).toBe(2);
    expect(hub.filled).toEqual(["guardian-real-id"]);
  });

  test("stops retrying once the connection no longer needs healing", async () => {
    // Models a disconnect (or a reconnect that replaced this subscription)
    // between attempts: the loop must not keep polling the gateway for a
    // connection that is gone.
    const hub = fakeHub();
    let calls = 0;
    startActorPrincipalHeal({
      hub,
      connectionId: "conn-1",
      resolve: () => {
        calls++;
        hub.setNeeds(false);
        return Promise.resolve(undefined);
      },
      delaysMs: NO_DELAYS,
    });
    await settle();

    expect(calls).toBe(1);
    expect(hub.filled).toEqual([]);
  });

  test("never starts a lookup when the connection is already healed or gone", async () => {
    const hub = fakeHub({ needs: false });
    const resolve = mock(() => Promise.resolve("guardian-real-id"));
    startActorPrincipalHeal({
      hub,
      connectionId: "conn-1",
      resolve,
      delaysMs: NO_DELAYS,
    });
    await settle();

    expect(resolve).toHaveBeenCalledTimes(0);
    expect(hub.filled).toEqual([]);
  });

  test("gives up after the schedule is exhausted without filling", async () => {
    const hub = fakeHub();
    let calls = 0;
    startActorPrincipalHeal({
      hub,
      connectionId: "conn-1",
      resolve: () => {
        calls++;
        return Promise.resolve(undefined);
      },
      delaysMs: NO_DELAYS,
    });
    await settle();

    expect(calls).toBe(NO_DELAYS.length);
    expect(hub.filled).toEqual([]);
  });

  test("dispatches the first attempt synchronously", () => {
    const hub = fakeHub();
    const resolve = mock(() => Promise.resolve("guardian-real-id"));
    startActorPrincipalHeal({
      hub,
      connectionId: "conn-1",
      resolve,
      delaysMs: NO_DELAYS,
    });

    // No await: the leading zero delay must not cost a macrotask, so a
    // warm-cache heal lands before the stream delivers its first event.
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
