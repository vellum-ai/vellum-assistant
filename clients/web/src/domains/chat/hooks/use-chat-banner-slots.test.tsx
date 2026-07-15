/**
 * Tests that `useChatBannerSlots` mirrors "a nudge banner is currently
 * visible" into the shared banner-visibility store — the mutual-exclusivity
 * contract the sidebar tip reads to avoid rendering alongside a banner.
 *
 * The banner components and queued drawer are stubbed via `mock.module` so
 * the test stays focused on the slot/visibility logic.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
import { useBannerVisibilityStore } from "@/stores/banner-visibility-store";

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

const bannerVisible = () =>
  useBannerVisibilityStore.getState().bannerVisible;

beforeEach(() => {
  useBannerVisibilityStore.setState({ bannerVisible: false });
});

afterEach(() => {
  cleanup();
});

// --- Tests ------------------------------------------------------------------

describe("useChatBannerSlots — banner-visibility mirroring", () => {
  test("no banner showing → slot null, store stays false", () => {
    const { result } = renderHook(useChatBannerSlots, {
      initialProps: makeParams(makeNudges()),
    });
    expect(result.current.mainBannerSlot).toBeNull();
    expect(bannerVisible()).toBe(false);
  });

  const flags = ["showBanner", "showGitHubBanner", "showDiscordBanner"] as const;
  for (const flag of flags) {
    test(`${flag} → slot renders, store flips true`, () => {
      const { result } = renderHook(useChatBannerSlots, {
        initialProps: makeParams(makeNudges({ [flag]: true })),
      });
      expect(result.current.mainBannerSlot).not.toBeNull();
      expect(bannerVisible()).toBe(true);
    });
  }

  test("banner hiding flips the store back to false", () => {
    const { rerender } = renderHook(useChatBannerSlots, {
      initialProps: makeParams(makeNudges({ showBanner: true })),
    });
    expect(bannerVisible()).toBe(true);

    rerender(makeParams(makeNudges()));
    expect(bannerVisible()).toBe(false);
  });

  test("unmount resets the store to false", () => {
    const { unmount } = renderHook(useChatBannerSlots, {
      initialProps: makeParams(makeNudges({ showGitHubBanner: true })),
    });
    expect(bannerVisible()).toBe(true);

    unmount();
    expect(bannerVisible()).toBe(false);
  });
});
