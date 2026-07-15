/**
 * Tests that `useChatBannerSlots` builds the main banner slot from the nudge
 * flags. Banner *visibility* is mirrored into the shared store by `ChatBody`
 * (which owns the actual mount conditions), not by this hook — see
 * `chat-body.test.tsx`.
 *
 * The banner components and queued drawer are stubbed via `mock.module` so
 * the test stays focused on the slot construction logic.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

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

import { useChatBannerSlots } from "@/domains/chat/hooks/use-chat-banner-slots";
import type { UseChatBannerSlotsParams } from "@/domains/chat/hooks/use-chat-banner-slots";

// --- Fixtures ---------------------------------------------------------------

type Nudges = UseChatBannerSlotsParams["nudges"];

const noop = () => {};

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
