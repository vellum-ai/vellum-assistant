/**
 * Tests that `useChatBannerSlots` builds the main banner slot from the nudge
 * state: any active nudge flag yields a slot node, none yields null.
 *
 * The banner components and queued drawer are stubbed via `mock.module` so
 * the test stays focused on the slot construction logic.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import type { UseTipCardResult } from "@/hooks/use-tip-card";
import type { Tip } from "@/utils/tips-catalog";

// --- Mocks ----------------------------------------------------------------

mock.module("@/components/nudges/discord-nudge-banner", () => ({
  DiscordNudgeBanner: () => null,
}));
mock.module("@/components/nudges/github-nudge-banner", () => ({
  GitHubNudgeBanner: () => null,
}));
mock.module("@/components/nudges/ios-app-banner", () => ({
  IOSAppBanner: () => null,
}));
mock.module("@/components/nudges/macos-app-banner", () => ({
  MacOSAppBanner: () => null,
}));
mock.module("@/domains/chat/components/queued-messages-drawer", () => ({
  QueuedMessagesDrawer: () => null,
}));
mock.module("@/components/tips/tip-chat-banner", () => ({
  TipChatBanner: () => null,
}));

// The tip experiment reads `useTipCard` inside the slot hook; drive it via a
// mutable fixture so tests stay focused on slot construction, not tip gating.
const tipCardResult: UseTipCardResult = makeTipCardResult();
mock.module("@/hooks/use-tip-card", () => ({
  useTipCard: () => tipCardResult,
}));

import { TipChatBanner } from "@/components/tips/tip-chat-banner";
import { useChatBannerSlots } from "@/domains/chat/hooks/use-chat-banner-slots";
import type { UseChatBannerSlotsParams } from "@/domains/chat/hooks/use-chat-banner-slots";

// --- Fixtures ---------------------------------------------------------------

type Nudges = UseChatBannerSlotsParams["nudges"];

const noop = () => {};

// Self-contained (no `noop`): invoked at module scope before the fixtures'
// const bindings initialize.
function makeTipCardResult(): UseTipCardResult {
  return {
    tip: null,
    placement: "sidebar",
    onDismiss: () => {},
    onLearnMore: () => {},
    onDontShowAgain: () => {},
    onNextTip: undefined,
  };
}

function makeTip(): Tip {
  return {
    id: "test-tip",
    kind: "info",
    source: "curated",
    eyebrow: "Tips",
    title: "A tip",
    body: "A tip body.",
  };
}

/** The slot is a single wrapper div around exactly one banner component. */
function bannerType(slot: ReactNode): unknown {
  return (slot as ReactElement<{ children: ReactElement }>).props.children
    .type;
}

function makeNudges(overrides: Partial<Nudges> = {}): Nudges {
  return {
    isOnIOS: false,
    isOnMacOS: true,
    isOnNudgePlatform: true,
    nudge: {
      bannerShouldShow: false,
      handleDownload: noop,
      handleBannerDismiss: noop,
    },
    showBanner: false,
    githubNudge: {
      bannerShouldShow: false,
      handleStar: noop,
      handleBannerDismiss: noop,
    },
    showGitHubBanner: false,
    discordNudge: {
      bannerShouldShow: false,
      handleJoin: noop,
      handleBannerDismiss: noop,
    },
    showDiscordBanner: false,
    ...overrides,
  };
}

function makeParams(nudges: Nudges): UseChatBannerSlotsParams {
  return {
    nudges,
    queuedMessages: [],
    onCancelQueuedMessage: noop,
    onCancelAllQueued: noop,
    onSteerMessage: noop,
    onEditQueueTail: noop,
    queueSteering: false,
  };
}

afterEach(() => {
  cleanup();
  Object.assign(tipCardResult, makeTipCardResult());
});

// --- Tests ------------------------------------------------------------------

describe("useChatBannerSlots — banner slot construction", () => {
  test("no nudge flag set → mainBannerSlot is null", () => {
    const { result } = renderHook(useChatBannerSlots, {
      initialProps: makeParams(makeNudges()),
    });
    expect(result.current.mainBannerSlot).toBeNull();
  });

  const flags = ["showBanner", "showGitHubBanner", "showDiscordBanner"] as const;
  for (const flag of flags) {
    test(`${flag} → mainBannerSlot renders`, () => {
      const { result } = renderHook(useChatBannerSlots, {
        initialProps: makeParams(makeNudges({ [flag]: true })),
      });
      expect(result.current.mainBannerSlot).not.toBeNull();
    });
  }

  test("clearing the flag drops the slot back to null", () => {
    const { result, rerender } = renderHook(useChatBannerSlots, {
      initialProps: makeParams(makeNudges({ showBanner: true })),
    });
    expect(result.current.mainBannerSlot).not.toBeNull();

    rerender(makeParams(makeNudges()));
    expect(result.current.mainBannerSlot).toBeNull();
  });
});

describe("useChatBannerSlots — experimental tip banner placement", () => {
  test("banner placement with a tip and no nudge → tip banner takes the slot", () => {
    tipCardResult.tip = makeTip();
    tipCardResult.placement = "banner";

    const { result } = renderHook(useChatBannerSlots, {
      initialProps: makeParams(makeNudges()),
    });

    expect(bannerType(result.current.mainBannerSlot)).toBe(TipChatBanner);
  });

  test("banner placement without a tip → slot stays null", () => {
    tipCardResult.placement = "banner";

    const { result } = renderHook(useChatBannerSlots, {
      initialProps: makeParams(makeNudges()),
    });

    expect(result.current.mainBannerSlot).toBeNull();
  });

  test("sidebar placement never claims the slot, even with a tip", () => {
    tipCardResult.tip = makeTip();
    tipCardResult.placement = "sidebar";

    const { result } = renderHook(useChatBannerSlots, {
      initialProps: makeParams(makeNudges()),
    });

    expect(result.current.mainBannerSlot).toBeNull();
  });

  const flags = ["showBanner", "showGitHubBanner", "showDiscordBanner"] as const;
  for (const flag of flags) {
    test(`${flag} outranks the tip banner`, () => {
      tipCardResult.tip = makeTip();
      tipCardResult.placement = "banner";

      const { result } = renderHook(useChatBannerSlots, {
        initialProps: makeParams(makeNudges({ [flag]: true })),
      });

      expect(result.current.mainBannerSlot).not.toBeNull();
      expect(bannerType(result.current.mainBannerSlot)).not.toBe(TipChatBanner);
    });
  }
});
