/**
 * Tests that `useChatBannerSlots` builds the main banner slot from the nudge
 * state: any active nudge flag yields a slot node, none yields null, and the
 * resolved mobile promotion is what picks the native banner over the macOS one.
 *
 * The banner components and queued drawer are stubbed via `mock.module` so
 * the test stays focused on the slot construction logic.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, renderHook, screen } from "@testing-library/react";

// --- Mocks ----------------------------------------------------------------

mock.module("@/components/nudges/discord-nudge-banner", () => ({
  DiscordNudgeBanner: () => null,
}));
mock.module("@/components/nudges/github-nudge-banner", () => ({
  GitHubNudgeBanner: () => null,
}));
mock.module("@/components/nudges/native-app-banner", () => ({
  NativeAppBanner: () => <div data-testid="native-app-banner" />,
}));
mock.module("@/components/nudges/macos-app-banner", () => ({
  MacOSAppBanner: () => <div data-testid="macos-app-banner" />,
}));
mock.module("@/domains/chat/components/queued-messages-drawer", () => ({
  QueuedMessagesDrawer: () => null,
}));

import { useChatBannerSlots } from "@/domains/chat/hooks/use-chat-banner-slots";
import type { UseChatBannerSlotsParams } from "@/domains/chat/hooks/use-chat-banner-slots";
import { resolveMobilePromotion } from "@/hooks/use-native-app-nudge";

// --- Fixtures ---------------------------------------------------------------

type Nudges = UseChatBannerSlotsParams["nudges"];

const noop = () => {};

function makeNudges(overrides: Partial<Nudges> = {}): Nudges {
  return {
    isOnIOS: false,
    isOnAndroid: false,
    isOnMacOS: true,
    isOnNudgePlatform: true,
    mobilePromotion: null,
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

  const flags = [
    "showBanner",
    "showGitHubBanner",
    "showDiscordBanner",
  ] as const;
  for (const flag of flags) {
    test(`${flag} → mainBannerSlot renders`, () => {
      const { result } = renderHook(useChatBannerSlots, {
        initialProps: makeParams(makeNudges({ [flag]: true })),
      });
      expect(result.current.mainBannerSlot).not.toBeNull();
    });
  }

  test("a resolved mobile promotion picks the native app banner", () => {
    const { result } = renderHook(useChatBannerSlots, {
      initialProps: makeParams(
        makeNudges({
          showBanner: true,
          mobilePromotion: resolveMobilePromotion("ios"),
        }),
      ),
    });

    render(result.current.mainBannerSlot);
    expect(screen.getByTestId("native-app-banner")).toBeDefined();
    expect(screen.queryByTestId("macos-app-banner")).toBeNull();
  });

  test("no mobile promotion falls through to the macOS banner", () => {
    const { result } = renderHook(useChatBannerSlots, {
      initialProps: makeParams(makeNudges({ showBanner: true })),
    });

    render(result.current.mainBannerSlot);
    expect(screen.getByTestId("macos-app-banner")).toBeDefined();
    expect(screen.queryByTestId("native-app-banner")).toBeNull();
  });

  test("clearing the flag drops the slot back to null", () => {
    const { result, rerender } = renderHook(useChatBannerSlots, {
      initialProps: makeParams(makeNudges({ showBanner: true })),
    });
    expect(result.current.mainBannerSlot).not.toBeNull();

    rerender(makeParams(makeNudges()));
    expect(result.current.mainBannerSlot).toBeNull();
  });
});
