/**
 * Tier is the notification filter's first-class attention concept; `Urgency`
 * stays the transport. These tests pin the mapping between the two and the
 * delivery behavior it produces, including the guarantee that a payload
 * carrying no tier is delivered exactly as it was before Tier existed.
 */

import { describe, expect, test } from "bun:test";

import type { AssistantEvent } from "../../api/index.js";
import { VellumAdapter } from "../adapters/macos.js";
import type { ChannelDeliveryPayload, ChannelDestination } from "../types.js";
import type { Urgency } from "../urgency.js";
import {
  compareTier,
  FALLBACK_TIER,
  resolveSilent,
  type Tier,
  TIER_ORDER,
  tierShouldNotify,
  tierToUrgency,
} from "./tier.js";

function makePayload(
  overrides: Partial<ChannelDeliveryPayload> = {},
): ChannelDeliveryPayload {
  return {
    deliveryId: "del-1",
    correlationId: "sig-1",
    sourceEventName: "user.send_notification",
    copy: { title: "Title", body: "Body" },
    urgency: "medium",
    ...overrides,
  };
}

const DESTINATION: ChannelDestination = {
  channel: "vellum",
  endpoint: "vellum",
  metadata: {},
};

async function broadcastSilentFlag(
  payload: ChannelDeliveryPayload,
): Promise<boolean | undefined> {
  const events: AssistantEvent[] = [];
  const adapter = new VellumAdapter((msg) => {
    events.push(msg);
  });
  const result = await adapter.send(payload, DESTINATION);
  expect(result.success).toBe(true);
  expect(events.length).toBe(1);
  return (events[0] as { silent?: boolean }).silent;
}

describe("tier to urgency mapping", () => {
  // Keyed by Tier, and iterated over TIER_ORDER, so a new tier fails to
  // compile here until its documented urgency is written down.
  const documented: Record<Tier, Urgency> = {
    suppress: "low",
    hint: "low",
    offer: "high",
    response: "critical",
  };

  for (const tier of TIER_ORDER) {
    test(`${tier} maps to ${documented[tier]}`, () => {
      expect(tierToUrgency(tier)).toBe(documented[tier]);
    });
  }
});

describe("tierShouldNotify", () => {
  test("is false only for suppress", () => {
    const notifying = TIER_ORDER.filter(tierShouldNotify);
    expect(notifying).toEqual(["hint", "offer", "response"]);
  });
});

describe("resolveSilent", () => {
  // Keyed by Tier, and iterated over TIER_ORDER, so a new tier fails to
  // compile here until its documented banner behavior is written down.
  const documented: Record<Tier, boolean> = {
    suppress: true,
    hint: true,
    offer: false,
    response: false,
  };

  for (const tier of TIER_ORDER) {
    test(`${tier} resolves silent=${documented[tier]} at every urgency`, () => {
      const urgencies: Urgency[] = ["low", "medium", "high", "critical"];
      for (const urgency of urgencies) {
        expect(resolveSilent(tier, urgency)).toBe(documented[tier]);
      }
    });
  }

  test("no tier falls back to urgency", () => {
    const expected: [Urgency, boolean][] = [
      ["low", true],
      ["medium", true],
      ["high", false],
      ["critical", false],
    ];
    for (const [urgency, silent] of expected) {
      expect(resolveSilent(undefined, urgency)).toBe(silent);
    }
  });

  test("a tier that must not notify is never allowed a banner", () => {
    for (const tier of TIER_ORDER) {
      if (!tierShouldNotify(tier)) {
        expect(resolveSilent(tier, "critical")).toBe(true);
      }
    }
  });
});

describe("compareTier", () => {
  test("totally orders TIER_ORDER least to most interrupting", () => {
    expect([...TIER_ORDER].reverse().sort(compareTier)).toEqual([
      ...TIER_ORDER,
    ]);
  });

  test("is zero for a tier against itself and antisymmetric otherwise", () => {
    for (const a of TIER_ORDER) {
      expect(compareTier(a, a)).toBe(0);
      for (const b of TIER_ORDER) {
        const forward = Math.sign(compareTier(a, b));
        const reverse = Math.sign(compareTier(b, a));
        expect(forward + reverse).toBe(0);
      }
    }
  });
});

describe("FALLBACK_TIER", () => {
  test("files quietly: never dropped, never interrupting", () => {
    // A broken judgment layer must not silently drop a notification, and must
    // not interrupt on a guess.
    expect(tierShouldNotify(FALLBACK_TIER)).toBe(true);
    expect(FALLBACK_TIER).not.toBe("suppress");
    expect(FALLBACK_TIER).not.toBe("response");
  });
});

describe("vellum adapter tier precedence", () => {
  test("hint broadcasts silent: true even at a banner-worthy urgency", async () => {
    expect(
      await broadcastSilentFlag(
        makePayload({ tier: "hint", urgency: "critical" }),
      ),
    ).toBe(true);
  });

  test("offer broadcasts silent: false even at a silent urgency", async () => {
    expect(
      await broadcastSilentFlag(makePayload({ tier: "offer", urgency: "low" })),
    ).toBe(false);
  });

  test("suppress broadcasts silent: true if it ever reaches the adapter", async () => {
    // The broadcaster drops suppress before dispatch, so this is the
    // belt-and-braces case: a payload that got here anyway must not banner.
    expect(
      await broadcastSilentFlag(
        makePayload({ tier: "suppress", urgency: "critical" }),
      ),
    ).toBe(true);
  });

  test("response broadcasts silent: false", async () => {
    expect(
      await broadcastSilentFlag(
        makePayload({ tier: "response", urgency: "low" }),
      ),
    ).toBe(false);
  });

  test("no tier keeps the urgency-derived behavior for every urgency", async () => {
    // The regression guard: every producer that does not go through the
    // filter must deliver byte-identically to how it did before Tier existed.
    const expected: [Urgency, boolean][] = [
      ["low", true],
      ["medium", true],
      ["high", false],
      ["critical", false],
    ];
    for (const [urgency, silent] of expected) {
      expect(await broadcastSilentFlag(makePayload({ urgency }))).toBe(silent);
    }
  });
});
