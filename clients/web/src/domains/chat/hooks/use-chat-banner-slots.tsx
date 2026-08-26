/**
 * Assembles the nudge and queued-message ReactNode slots that
 * {@link ChatBody} renders in the main chat panel.
 *
 * Factored out of the orchestrator so the slot construction logic is
 * testable independently and the orchestrator stays focused on wiring.
 */

import { type ReactNode, useMemo } from "react";

import { DiscordNudgeBanner } from "@/components/nudges/discord-nudge-banner";
import { GitHubNudgeBanner } from "@/components/nudges/github-nudge-banner";
import { MacOSAppBanner } from "@/components/nudges/macos-app-banner";
import { NativeAppBanner } from "@/components/nudges/native-app-banner";
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
}: UseChatBannerSlotsParams): ChatBannerSlots {
  const {
    showBanner,
    mobilePromotion,
    nudge,
    showGitHubBanner,
    githubNudge,
    showDiscordBanner,
    discordNudge,
  } = nudges;

  const mainBannerSlot = useMemo((): ReactNode => {
    if (showBanner) {
      return (
        <div className="w-full px-3 pb-2 sm:px-6">
          {mobilePromotion ? (
            <NativeAppBanner
              promotion={mobilePromotion}
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
        <div className="w-full px-3 pb-2 sm:px-6">
          <GitHubNudgeBanner
            onStar={githubNudge.handleStar}
            onDismiss={githubNudge.handleBannerDismiss}
          />
        </div>
      );
    }
    if (showDiscordBanner) {
      return (
        <div className="w-full px-3 pb-1 sm:px-6">
          <DiscordNudgeBanner
            onJoin={discordNudge.handleJoin}
            onDismiss={discordNudge.handleBannerDismiss}
          />
        </div>
      );
    }
    return null;
  }, [
    showBanner,
    mobilePromotion,
    nudge,
    showGitHubBanner,
    githubNudge,
    showDiscordBanner,
    discordNudge,
  ]);

  const mainQueuedDrawerSlot = useMemo(
    (): ReactNode => (
      <QueuedMessagesDrawer
        queuedMessages={queuedMessages}
        onCancelMessage={onCancelQueuedMessage}
        onCancelAll={onCancelAllQueued}
        onSteer={onSteerMessage}
        onEditTail={onEditQueueTail}
      />
    ),
    [
      queuedMessages,
      onCancelQueuedMessage,
      onCancelAllQueued,
      onSteerMessage,
      onEditQueueTail,
    ],
  );

  return { mainBannerSlot, mainQueuedDrawerSlot };
}
