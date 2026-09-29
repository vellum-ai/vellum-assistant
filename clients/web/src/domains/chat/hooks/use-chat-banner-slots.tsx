/**
 * Assembles the nudge banner ReactNode slot that {@link ChatBody} renders
 * in the main chat panel.
 *
 * Factored out of the orchestrator so the slot construction logic is
 * testable independently and the orchestrator stays focused on wiring.
 */

import { type ReactNode, useMemo } from "react";

import { DiscordNudgeBanner } from "@/components/nudges/discord-nudge-banner";
import { GitHubNudgeBanner } from "@/components/nudges/github-nudge-banner";
import { DesktopAppBanner } from "@/components/nudges/desktop-app-banner";
import { NativeAppBanner } from "@/components/nudges/native-app-banner";
import type { useAppNudges } from "@/domains/chat/hooks/use-app-nudges";

// ---------------------------------------------------------------------------
// Params & return type
// ---------------------------------------------------------------------------

export interface UseChatBannerSlotsParams {
  nudges: ReturnType<typeof useAppNudges>;
}

export interface ChatBannerSlots {
  mainBannerSlot: ReactNode;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useChatBannerSlots({
  nudges,
}: UseChatBannerSlotsParams): ChatBannerSlots {
  const {
    showBanner,
    mobilePromotion,
    desktopAppPlatform,
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
            <DesktopAppBanner
              platform={desktopAppPlatform}
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
    desktopAppPlatform,
    nudge,
    showGitHubBanner,
    githubNudge,
    showDiscordBanner,
    discordNudge,
  ]);

  return { mainBannerSlot };
}
