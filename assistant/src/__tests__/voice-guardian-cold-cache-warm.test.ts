/**
 * Cold-cache guardian classification regression.
 *
 * The sync trust resolver (`resolveActorTrust`) reads the IO-free guardian-
 * delivery cache snapshot (`peekCachedGuardianDelivery`) keyed per channel
 * filter. On a cold process only `vellum` is warmed at daemon startup, so
 * other channel keys stay empty until some async read warms that exact key —
 * a cold snapshot classifies `unknown`, and gateway-side binding writes don't
 * invalidate the daemon cache, so only `getGuardianDeliveryFresh` bypasses a
 * stale empty snapshot before the TTL.
 *
 * This test drives the REAL guardian-delivery reader cache (mocking only the
 * gateway `ipcCall`) so the cold→warm transition is exercised end to end.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

const GUARDIAN_PHONE = "+15550100";

// Gateway IPC stub: returns the phone guardian delivery. The real reader caches
// the result under the `phone` key, so a subsequent sync `peek` finds it. When
// `guardianBound` is false the gateway reports no guardian — simulating the
// pre-binding state whose empty result the cache would otherwise pin.
let guardianBound = true;
let ipcCalls: Array<{ route: string; input: unknown }> = [];
mock.module("../ipc/gateway-client.js", () => ({
  ipcCall: async (route: string, input: unknown) => {
    ipcCalls.push({ route, input });
    return {
      guardians: guardianBound
        ? [
            {
              channelType: "phone",
              contactId: "guardian-contact",
              principalId: "P_GUARDIAN_COLD",
              address: GUARDIAN_PHONE,
              externalChatId: null,
              status: "active",
            },
          ]
        : [],
    };
  },
}));

import {
  __resetGuardianDeliveryCacheForTest,
  getGuardianDelivery,
  getGuardianDeliveryFresh,
  peekCachedGuardianDelivery,
} from "../contacts/guardian-delivery-reader.js";
import { resolveActorTrust } from "../runtime/actor-trust-resolver.js";

describe("guardian-delivery cache cold→warm transition for sync trust", () => {
  beforeEach(() => {
    __resetGuardianDeliveryCacheForTest();
    ipcCalls = [];
    guardianBound = true;
  });

  test("cold phone cache: guardian call misclassifies until upstream warm", async () => {
    // Precondition: cold cache for phone — the sync peek would miss.
    expect(
      peekCachedGuardianDelivery({ channelTypes: ["phone"] }),
    ).toBeUndefined();

    // Sync resolve on a cold cache: no guardian snapshot → classified unknown.
    const cold = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: "phone",
      conversationExternalId: GUARDIAN_PHONE,
      actorExternalId: GUARDIAN_PHONE,
    });
    expect(cold.trustClass).toBe("unknown");

    // A fresh read warms the phone-specific key.
    await getGuardianDeliveryFresh({ channelTypes: ["phone"] });
    expect(
      ipcCalls.some(
        (c) =>
          c.route === "resolve_guardian_delivery" &&
          JSON.stringify(c.input) ===
            JSON.stringify({ channelTypes: ["phone"] }),
      ),
    ).toBe(true);

    // The sync resolve, reading the now-warm snapshot, classifies the caller as
    // the guardian — not misclassified as `unknown`.
    const warm = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: "phone",
      conversationExternalId: GUARDIAN_PHONE,
      actorExternalId: GUARDIAN_PHONE,
    });
    expect(warm.trustClass).toBe("guardian");
  });

  test("fresh warm bypasses a stale empty phone snapshot after a gateway-side binding", async () => {
    // An earlier setup cached an empty phone snapshot (no guardian yet). Gateway-
    // side binding writes don't invalidate the daemon cache, so the entry stays
    // warm-but-stale until the TTL.
    guardianBound = false;
    await getGuardianDelivery({ channelTypes: ["phone"] });
    expect(peekCachedGuardianDelivery({ channelTypes: ["phone"] })).toEqual([]);

    // Guardian binding now exists gateway-side. A non-force read would still
    // return the pinned empty snapshot; the fresh read bypasses it.
    guardianBound = true;
    expect(await getGuardianDelivery({ channelTypes: ["phone"] })).toEqual([]);
    await getGuardianDeliveryFresh({ channelTypes: ["phone"] });

    // The sync resolve now reads the refreshed snapshot and classifies guardian.
    const warm = resolveActorTrust({
      assistantId: "asst-1",
      sourceChannel: "phone",
      conversationExternalId: GUARDIAN_PHONE,
      actorExternalId: GUARDIAN_PHONE,
    });
    expect(warm.trustClass).toBe("guardian");
  });

  test("startup vellum-only warm leaves the phone key cold", async () => {
    // Daemon startup warms only `vellum`; that must not populate the `phone` key.
    await getGuardianDelivery({ channelTypes: ["vellum"] });
    expect(
      peekCachedGuardianDelivery({ channelTypes: ["phone"] }),
    ).toBeUndefined();
  });
});
