import { useEffect, useRef, useState } from "react";

import { type DisplayMessage } from "@/domains/chat/types/types";
import { hasAnyInteractiveSurface } from "@/domains/chat/utils/chat";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import {
  getNativeAppPromotion,
  incrementNativeAppAssistantTurnsSeen,
  NATIVE_APP_BANNER_MIN_TURNS,
  readNativeAppAssistantTurnsSeen,
  useNativeAppNudgeState,
  type NativeAppPlatform,
} from "@/hooks/use-native-app-nudge";
import {
  readMacOsAssistantTurnsSeen,
  incrementMacOsAssistantTurnsSeen,
  useMacOsNudgeState,
  MAC_APP_BANNER_MIN_TURNS,
} from "@/hooks/use-macos-app-nudge";
import {
  useGitHubNudgeState,
  ensureGitHubFirstSeenAt,
  readGitHubUserMessagesSeen,
  incrementGitHubUserMessagesSeen,
  GITHUB_MIN_USER_MESSAGES,
  type GitHubNudgeState,
} from "@/hooks/use-github-nudge";
import {
  useDiscordNudgeState,
  ensureFirstSeenAt,
  type DiscordNudgeState,
} from "@/hooks/use-discord-nudge";
import {
  useIsAndroidWeb,
  useIsIOSWeb,
  useIsMacOSWeb,
} from "@/runtime/platform-detection";

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
 * (native mobile/macOS app download, GitHub star, Discord community).
 *
 * Mutual-exclusivity rules:
 * 1. Only one platform nudge shows at a time.
 * 2. GitHub nudge surfaces only once the platform nudge is resolved.
 * 3. Discord nudge surfaces only once GitHub is resolved, with a cooldown.
 * 4. All nudges are suppressed while an interactive surface (choice, form,
 *    confirmation, etc.) is awaiting user input — these surfaces render
 *    inline in the transcript and visually collide with the floating nudge
 *    banner above the composer (LUM-2777).
 */
export interface AppNudgesState {
  /** True when the current iOS browser is eligible for custom promotion. */
  isOnIOS: boolean;
  /** True when Android web promotion is configured for this deployment. */
  isOnAndroid: boolean;
  /** True when the current browser is macOS Safari or Chrome (non-native). */
  isOnMacOS: boolean;
  /** True when any platform app-download nudge could apply. */
  isOnNudgePlatform: boolean;

  /** Mobile platform for the active native-app promotion, when applicable. */
  nativeAppPlatform: NativeAppPlatform | null;
  /** The active platform nudge. Handlers are platform-specific. */
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
 * Manages the full nudge stack: platform app-download, GitHub
 * star, and Discord community join. Tracks completed assistant turns to
 * gate the platform nudge behind a minimum-turn threshold, then cascades
 * visibility through the GitHub and Discord nudges with mutual-exclusivity
 * guarantees.
 *
 * @param messages - Current transcript messages (used to count completed assistant turns).
 * @param conversationCount - Total conversation count (gates the Discord nudge).
 * @param liveAssistantMessageId - Id of the currently-live assistant row, or
 *   `null` when nothing is streaming. Derived from message position and the
 *   conversation's processing state.
 * @param activeConversationId - Current conversation ID for user-message tracking.
 */
export function useAppNudges(
  messages: readonly DisplayMessage[],
  conversationCount: number,
  liveAssistantMessageId: string | null,
  activeConversationId: string | null,
): AppNudgesState {
  // -------------------------------------------------------------------------
  // Platform detection
  // -------------------------------------------------------------------------
  const isOnIOS = useIsIOSWeb();
  const isOnAndroid =
    useIsAndroidWeb() && getNativeAppPromotion("android") !== null;
  const isOnMacOS = useIsMacOSWeb();
  const nativeAppPlatform: NativeAppPlatform | null = isOnIOS
    ? "ios"
    : isOnAndroid
      ? "android"
      : null;
  const isOnNudgePlatform = nativeAppPlatform !== null || isOnMacOS;
  const nudgeMinTurns = nativeAppPlatform
    ? NATIVE_APP_BANNER_MIN_TURNS
    : MAC_APP_BANNER_MIN_TURNS;

  // -------------------------------------------------------------------------
  // Turn counting — gate the platform nudge behind a minimum-turn threshold
  // -------------------------------------------------------------------------
  const [assistantTurnsSeen, setAssistantTurnsSeen] = useState(0);

  useEffect(() => {
    setAssistantTurnsSeen(
      nativeAppPlatform
        ? readNativeAppAssistantTurnsSeen(nativeAppPlatform)
        : readMacOsAssistantTurnsSeen(),
    );
  }, [nativeAppPlatform]);

  useEffect(() => {
    if (!isOnNudgePlatform) {
      return;
    }
    if (assistantTurnsSeen >= nudgeMinTurns) {
      return;
    }

    let newlyCompleted = 0;
    const streamingIds = useChatSessionStore.getState().streamingMessageIds;
    const toAdd: string[] = [];
    const toRemove: string[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role !== "assistant") {
        continue;
      }
      if (m.id === liveAssistantMessageId) {
        toAdd.push(m.id);
      } else if (streamingIds.has(m.id)) {
        toRemove.push(m.id);
        newlyCompleted++;
      } else {
        break;
      }
    }
    if (toAdd.length > 0 || toRemove.length > 0) {
      useChatSessionStore
        .getState()
        .batchUpdateStreamingMessageIds(toAdd, toRemove);
    }

    if (newlyCompleted > 0) {
      if (nativeAppPlatform) {
        incrementNativeAppAssistantTurnsSeen(
          nativeAppPlatform,
          newlyCompleted,
        );
      } else {
        incrementMacOsAssistantTurnsSeen(newlyCompleted);
      }
      setAssistantTurnsSeen((current) => current + newlyCompleted);
    }
  }, [
    messages,
    liveAssistantMessageId,
    isOnNudgePlatform,
    nativeAppPlatform,
    assistantTurnsSeen,
    nudgeMinTurns,
  ]);

  // -------------------------------------------------------------------------
  // Active interactive surface — suppress nudges while a surface (choice,
  // form, confirmation, etc.) is awaiting user input. These surfaces render
  // inline in the transcript and visually collide with the floating nudge
  // banner above the composer (LUM-2777).
  // -------------------------------------------------------------------------
  const hasActiveInteractiveSurface = hasAnyInteractiveSurface(messages);

  // -------------------------------------------------------------------------
  // Platform nudge
  // -------------------------------------------------------------------------
  const iosNudge = useNativeAppNudgeState("ios");
  const androidNudge = useNativeAppNudgeState("android");
  const macNudge = useMacOsNudgeState();
  const nudge =
    nativeAppPlatform === "ios"
      ? iosNudge
      : nativeAppPlatform === "android"
        ? androidNudge
        : macNudge;

  // macOS is time-based; native mobile promotion is turn-based.
  const bannerEligible = nativeAppPlatform
    ? assistantTurnsSeen >= NATIVE_APP_BANNER_MIN_TURNS
    : macNudge.ageEligible;

  const showBanner =
    isOnNudgePlatform &&
    bannerEligible &&
    nudge.bannerShouldShow &&
    !hasActiveInteractiveSurface;

  // -------------------------------------------------------------------------
  // GitHub star nudge — only after platform nudge is resolved
  // -------------------------------------------------------------------------
  useEffect(() => {
    ensureGitHubFirstSeenAt();
  }, []);

  // Track user messages sent (cumulative, conversation-aware).
  // Uses clientMessageId (stable correlation nonce) as the primary key so
  // the same send isn't double-counted when the optimistic client-UUID id
  // is swapped to the server-assigned messageId on user_message_echo.
  const trackedConversationIdRef = useRef<string | null>(null);
  const seenUserMsgKeysRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (readGitHubUserMessagesSeen() >= GITHUB_MIN_USER_MESSAGES) {
      return;
    }

    // On conversation switch or first observation: snapshot existing messages
    if (activeConversationId !== trackedConversationIdRef.current) {
      trackedConversationIdRef.current = activeConversationId;
      seenUserMsgKeysRef.current = new Set<string>();
      for (const m of messages) {
        if (m.role === "user") {
          seenUserMsgKeysRef.current.add(m.clientMessageId ?? m.id);
        }
      }
      return;
    }

    // Count newly-sent user messages
    let newCount = 0;
    for (const m of messages) {
      if (m.role !== "user") {
        continue;
      }
      const key = m.clientMessageId ?? m.id;
      if (!seenUserMsgKeysRef.current.has(key)) {
        seenUserMsgKeysRef.current.add(key);
        newCount++;
      }
    }

    if (newCount > 0) {
      incrementGitHubUserMessagesSeen(newCount);
    }
  }, [messages, activeConversationId]);

  const githubNudge = useGitHubNudgeState();
  const platformNudgeResolved = !isOnNudgePlatform || !nudge.bannerShouldShow;
  const showGitHubBanner =
    platformNudgeResolved &&
    githubNudge.bannerShouldShow &&
    !hasActiveInteractiveSurface;

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
    !showBanner &&
    !showGitHubBanner &&
    discordNudge.bannerShouldShow &&
    !hasActiveInteractiveSurface;

  return {
    isOnIOS,
    isOnAndroid,
    isOnMacOS,
    isOnNudgePlatform,
    nativeAppPlatform,
    nudge,
    showBanner,
    githubNudge,
    showGitHubBanner,
    discordNudge,
    showDiscordBanner,
  };
}
