/**
 * Assembles the nudge and queued-message ReactNode slots that
 * {@link ChatBody} renders in the main chat panel.
 *
 * Factored out of the orchestrator so the slot construction logic is
 * testable independently and the orchestrator stays focused on wiring.
 */

import { type ReactNode, useEffect, useMemo } from "react";

import { useBannerVisibilityStore } from "@/stores/banner-visibility-store";
import { DiscordNudgeBanner } from "@/components/nudges/discord-nudge-banner";
import { GitHubNudgeBanner } from "@/components/nudges/github-nudge-banner";
import { IOSAppBanner } from "@/components/nudges/ios-app-banner";
import { MacOSAppBanner } from "@/components/nudges/macos-app-banner";
import { QueuedMessagesDrawer } from "@/domains/chat/components/queued-messages-drawer";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { useAppNudges } from "@/domains/chat/hooks/use-app-nudges";

// ---------------------------------------------------------------------------
// Params & return type
// ---------------------------------------------------------------------------

export interface UseChatBannerSlotsParams {
  nudges: ReturnType<typeof useAppNudges>;
  queuedMessages: DisplayMessage[];
  onCancelQueuedMessage: (messageId: string) => void;
  onCancelAllQueued: () => void;
  onSteerMessage: (messageId: string) => void;
  onEditQueueTail: () => void;
  queueSteering: boolean;
}

export interface ChatBannerSlots {
  mainBannerSlot: ReactNode;
  mainQueuedDrawerSlot: ReactNode;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChatBannerSlots({
  nudges,
  queuedMessages,
  onCancelQueuedMessage,
  onCancelAllQueued,
  onSteerMessage,
  onEditQueueTail,
  queueSteering,
}: UseChatBannerSlotsParams): ChatBannerSlots {
  const {
    showBanner, isOnIOS, nudge,
    showGitHubBanner, githubNudge,
    showDiscordBanner, discordNudge,
  } = nudges;

  const mainBannerSlot = useMemo((): ReactNode => {
    if (showBanner) {
      return (
        <div className="pointer-events-auto w-full px-3 pb-2 sm:px-6">
          {isOnIOS ? (
            <IOSAppBanner
              onDownload={nudge.handleDownload}
              onDismiss={nudge.handleBannerDismiss}
            />
          ) : (
            <MacOSAppBanner
              onDownload={nudge.handleDownload}
              onDismiss={nudge.handleBannerDismiss}
            />
          )}
        </div>
      );
    }
    if (showGitHubBanner) {
      return (
        <div className="pointer-events-auto w-full px-3 pb-2 sm:px-6">
          <GitHubNudgeBanner
            onStar={githubNudge.handleStar}
            onDismiss={githubNudge.handleBannerDismiss}
          />
        </div>
      );
    }
    if (showDiscordBanner) {
      return (
        <div className="pointer-events-auto w-full px-3 pb-2 sm:px-6">
          <DiscordNudgeBanner
            onJoin={discordNudge.handleJoin}
            onDismiss={discordNudge.handleBannerDismiss}
          />
        </div>
      );
    }
    return null;
  }, [showBanner, isOnIOS, nudge, showGitHubBanner, githubNudge, showDiscordBanner, discordNudge]);

  // Mirror banner visibility into the shared store so the sidebar tip can
  // stay mutually exclusive with nudge banners.
  const bannerVisible = mainBannerSlot !== null;
  useEffect(() => {
    const { setBannerVisible } = useBannerVisibilityStore.getState();
    setBannerVisible(bannerVisible);
    return () => setBannerVisible(false);
  }, [bannerVisible]);

  const mainQueuedDrawerSlot = useMemo((): ReactNode => (
    <QueuedMessagesDrawer
      queuedMessages={queuedMessages}
      onCancelMessage={onCancelQueuedMessage}
      onCancelAll={onCancelAllQueued}
      onSteer={onSteerMessage}
      showSteer={queueSteering}
      onEditTail={onEditQueueTail}
    />
  ), [queuedMessages, onCancelQueuedMessage, onCancelAllQueued, onSteerMessage, queueSteering, onEditQueueTail]);

  return { mainBannerSlot, mainQueuedDrawerSlot };
}
