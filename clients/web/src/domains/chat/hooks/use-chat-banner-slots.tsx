/**
 * Assembles the nudge, queued-message, and Slack readonly banner
 * ReactNode slots that {@link ChatBody} renders in the main chat panel.
 *
 * Factored out of the orchestrator so the slot construction logic is
 * testable independently and the orchestrator stays focused on wiring.
 */

import { type ReactNode, useMemo } from "react";

import { DiscordNudgeBanner } from "@/components/nudges/discord-nudge-banner";
import { GitHubNudgeBanner } from "@/components/nudges/github-nudge-banner";
import { IOSAppBanner } from "@/components/nudges/ios-app-banner";
import { MacOSAppBanner } from "@/components/nudges/macos-app-banner";
import { QueuedMessagesDrawer } from "@/domains/chat/components/queued-messages-drawer";
import { SlackChannelFooter } from "@/domains/chat/components/slack-channel-footer";
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
  activeConversation: { originChannel?: string; conversationId?: string } | null | undefined;
  sanitizedMessages: DisplayMessage[];
  assistantId: string | null;
}

export interface ChatBannerSlots {
  mainBannerSlot: ReactNode;
  mainQueuedDrawerSlot: ReactNode;
  slackReadonlyBannerSlot: ReactNode;
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
  activeConversation,
  sanitizedMessages,
  assistantId,
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

  const slackReadonlyBannerSlot = useMemo((): ReactNode => {
    if (activeConversation?.originChannel !== "slack") return null;
    return (
      <SlackChannelFooter
        assistantId={assistantId ?? undefined}
        conversation={activeConversation}
        messages={sanitizedMessages}
      />
    );
  }, [activeConversation, sanitizedMessages, assistantId]);

  return { mainBannerSlot, mainQueuedDrawerSlot, slackReadonlyBannerSlot };
}
