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
import { ConversationAdmissionFloorSection } from "@/components/conversation-card/conversation-admission-floor-section";
import { QueuedMessagesDrawer } from "@/domains/chat/components/queued-messages-drawer";
import { SlackChannelFooter } from "@/domains/chat/components/slack-channel-footer";
import { isChannelConversation } from "@/domains/chat/utils/conversation-channel";
import { isInternalChannel } from "@/lib/channel-admission-policy/api";
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
  /** Per-conversation trust-floor picker (§8.3). Non-null for external channel conversations only. */
  channelFloorSlot: ReactNode;
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

  // §8.3: per-conversation trust-floor picker. Use `isChannelConversation()`
  // instead of a raw originChannel check so `notification:*` outbound-only
  // conversations are excluded (they have no inbound admission surface).
  // Also guard against internal channels per §8.1.
  const channelFloorSlot = useMemo((): ReactNode => {
    const originChannel = activeConversation?.originChannel;
    const conversationId = activeConversation?.conversationId;
    if (!conversationId) return null;
    if (!isChannelConversation(activeConversation)) return null;
    if (originChannel && isInternalChannel(originChannel)) return null;
    return (
      <ConversationAdmissionFloorSection
        conversationId={conversationId}
        originChannel={originChannel ?? ""}
      />
    );
  }, [activeConversation]);

  return { mainBannerSlot, mainQueuedDrawerSlot, slackReadonlyBannerSlot, channelFloorSlot };
}
