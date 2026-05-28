import { type MutableRefObject, useEffect, useState } from "react";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import { useIsIOSWeb, useIsMacOSWeb } from "@/runtime/platform-detection";
import {
  readIOSAssistantTurnsSeen,
  incrementIOSAssistantTurnsSeen,
  useIOSNudgeState,
  IOS_APP_BANNER_MIN_TURNS,
} from "@/hooks/use-ios-app-nudge";
import {
  readMacOsAssistantTurnsSeen,
  incrementMacOsAssistantTurnsSeen,
  useMacOsNudgeState,
  MAC_APP_BANNER_MIN_TURNS,
} from "@/hooks/use-macos-app-nudge";
import { useGitHubNudgeState, type GitHubNudgeState } from "@/hooks/use-github-nudge";
import { useDiscordNudgeState, ensureFirstSeenAt, type DiscordNudgeState } from "@/hooks/use-discord-nudge";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlatformNudgeState {
  bannerShouldShow: boolean;
  handleDownload: () => void;
  handleBannerDismiss: () => void;
}

/**
 * Aggregated nudge visibility and handlers for every nudge surface
 * (iOS/macOS app download, GitHub star, Discord community).
 *
 * Mutual-exclusivity rules:
 * 1. Only one platform nudge shows at a time (iOS xor macOS).
 * 2. GitHub nudge surfaces only once the platform nudge is resolved.
 * 3. Discord nudge surfaces only once GitHub is resolved, with a cooldown.
 */
export interface AppNudgesState {
  /** True when the current browser is iOS Safari (non-native). */
  isOnIOS: boolean;
  /** True when the current browser is macOS Safari or Chrome (non-native). */
  isOnMacOS: boolean;
  /** True when any platform app-download nudge could apply. */
  isOnNudgePlatform: boolean;

  /** The active platform nudge (iOS or macOS). Handlers are platform-specific. */
  nudge: PlatformNudgeState;
  /** Whether the main-area app-download banner should render. */
  showBanner: boolean;

  /** GitHub star nudge state and handlers. */
  githubNudge: GitHubNudgeState;
  showGitHubBanner: boolean;

  /** Discord community nudge state and handlers. */
  discordNudge: DiscordNudgeState;
  showDiscordBanner: boolean;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Manages the full nudge stack: platform app-download (iOS/macOS), GitHub
 * star, and Discord community join. Tracks completed assistant turns to
 * gate the platform nudge behind a minimum-turn threshold, then cascades
 * visibility through the GitHub and Discord nudges with mutual-exclusivity
 * guarantees.
 *
 * @param messages - Current transcript messages (used to count completed assistant turns).
 * @param conversationCount - Total conversation count (gates the Discord nudge).
 */
export function useAppNudges(
  messages: readonly DisplayMessage[],
  conversationCount: number,
  streamingMessageIdsRef: MutableRefObject<Set<string>>,
): AppNudgesState {
  // -------------------------------------------------------------------------
  // Platform detection
  // -------------------------------------------------------------------------
  const isOnIOS = useIsIOSWeb();
  const isOnMacOS = useIsMacOSWeb();
  const isOnNudgePlatform = isOnIOS || isOnMacOS;
  const nudgeMinTurns = isOnIOS ? IOS_APP_BANNER_MIN_TURNS : MAC_APP_BANNER_MIN_TURNS;

  // -------------------------------------------------------------------------
  // Turn counting — gate the platform nudge behind a minimum-turn threshold
  // -------------------------------------------------------------------------
  const [assistantTurnsSeen, setAssistantTurnsSeen] = useState(0);

  useEffect(() => {
    setAssistantTurnsSeen(
      isOnIOS ? readIOSAssistantTurnsSeen() : readMacOsAssistantTurnsSeen(),
    );
  }, [isOnIOS]);

  useEffect(() => {
    if (!isOnNudgePlatform) return;
    if (assistantTurnsSeen >= nudgeMinTurns) return;

    let newlyCompleted = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role !== "assistant") continue;
      if (m.isStreaming) {
        streamingMessageIdsRef.current.add(m.id);
      } else if (streamingMessageIdsRef.current.has(m.id)) {
        streamingMessageIdsRef.current.delete(m.id);
        newlyCompleted++;
      } else {
        break;
      }
    }

    if (newlyCompleted > 0) {
      if (isOnIOS) {
        incrementIOSAssistantTurnsSeen(newlyCompleted);
      } else {
        incrementMacOsAssistantTurnsSeen(newlyCompleted);
      }
      setAssistantTurnsSeen((current) => current + newlyCompleted);
    }
  }, [messages, isOnNudgePlatform, isOnIOS, assistantTurnsSeen, nudgeMinTurns]);

  const bannerEligible = assistantTurnsSeen >= nudgeMinTurns;

  // -------------------------------------------------------------------------
  // Platform nudge (iOS xor macOS)
  // -------------------------------------------------------------------------
  const iosNudge = useIOSNudgeState();
  const macNudge = useMacOsNudgeState();
  const nudge = isOnIOS ? iosNudge : macNudge;

  const showBanner = isOnNudgePlatform && bannerEligible && nudge.bannerShouldShow;

  // -------------------------------------------------------------------------
  // GitHub star nudge — only after platform nudge is resolved
  // -------------------------------------------------------------------------
  const githubNudge = useGitHubNudgeState();
  const platformNudgeResolved =
    !isOnNudgePlatform || !nudge.bannerShouldShow;
  const showGitHubBanner =
    platformNudgeResolved && githubNudge.bannerShouldShow;

  // -------------------------------------------------------------------------
  // Discord community nudge — only after GitHub nudge is resolved
  // -------------------------------------------------------------------------
  useEffect(() => {
    ensureFirstSeenAt();
  }, []);

  const discordNudge = useDiscordNudgeState(
    platformNudgeResolved,
    conversationCount,
  );
  const showDiscordBanner =
    !showBanner && !showGitHubBanner && discordNudge.bannerShouldShow;

  return {
    isOnIOS,
    isOnMacOS,
    isOnNudgePlatform,
    nudge,
    showBanner,
    githubNudge,
    showGitHubBanner,
    discordNudge,
    showDiscordBanner,
  };
}
