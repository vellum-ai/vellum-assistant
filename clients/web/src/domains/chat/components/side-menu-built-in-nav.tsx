import type { ReactNode } from "react";

import { SIDEBAR_STACK_GAP } from "@/components/sidebar-nav-geometry";
import { useNavigate } from "react-router";

import { AssistantSwitcher } from "@/domains/chat/components/assistant-switcher";
import { EmailNavItem } from "@/domains/chat/components/email-nav-item";
import { PinnedAppNavItem } from "@/domains/chat/components/pinned-app-nav-item";
import { useEmailPinned } from "@/hooks/use-email-pinned";
import { usePinnedApps } from "@/hooks/use-pinned-apps";
import { cn } from "@vellumai/design-library";
import { useTranslation } from "@/i18n";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { routes } from "@/utils/routes";

export interface SideMenuBuiltInNavProps {
  assistantId: string | null;
  /** Shown on the assistant row; falls back to "Your Assistant". */
  assistantName?: string | null;
  collapsed: boolean;
  variant: "rail" | "overlay";
  isIntelligenceActive?: boolean;
  onOpenIntelligence?: () => void;
  onStartNewConversation?: () => void;
  activeAppId?: string;
  onOpenApp?: (appId: string) => void;
  onClose?: () => void;
  /** The assistant section's toggle, beside the assistant pill. */
  assistantAside?: ReactNode;
  /** The assistant's own section, opened beneath the assistant row. */
  assistantBeneath?: ReactNode;
}

/**
 * The sidebar's built-in navigation block: the assistant cluster with the
 * New Chat button on its row, then the pinned-apps list. On the rail this lives
 * in the non-scrolling header; on the overlay it renders at the top of the
 * body so the whole menu scrolls as one surface (Figma 6764:6745).
 *
 * The block carries neither a heading over the pinned apps nor a rule under
 * them, in either state. Every entry here is a pill (a circle on the rail) on
 * the page background, and a shape like that is already delimited - a label
 * and a rule on top of it divide a group that reads as grouped without them.
 */
export function SideMenuBuiltInNav({
  assistantId,
  assistantName,
  collapsed,
  variant,
  isIntelligenceActive = false,
  onOpenIntelligence,
  onStartNewConversation,
  activeAppId,
  onOpenApp,
  onClose,
  assistantAside,
  assistantBeneath,
}: SideMenuBuiltInNavProps) {
  const { t } = useTranslation("chat");
  const navigate = useNavigate();
  const { pinnedApps, unpin, setColor } = usePinnedApps(assistantId);
  /* The Email pin, set from the profile's Email card. Behind the inbox's
     flag, since it opens the inbox. */
  const inboxEnabled = useClientFeatureFlagStore.use.assistantInbox();
  const emailPin = useEmailPinned(assistantId);
  const showsEmailPin = inboxEnabled && emailPin.pinned;

  /* One column at a single gap, rather than each cluster spacing itself.
     `SideMenu.Header` puts its own gap between its children, so a margin
     here would add to that and the block would space its two clusters at
     16px while spacing the pinned apps inside one of them at 4px. Wrapping
     makes the whole block one header child, so this gap is the only one
     between any two entries. */
  return (
    <div className={cn("flex flex-col", SIDEBAR_STACK_GAP)}>
      {/* The assistant cluster: the avatar-colored assistant row with the
          New Chat button (avatar-tinted, a round plus) after the section
          toggle on that row, so the identity leads and the action hangs
          off it; on the collapsed rail the button is an icon-only tile
          beneath the assistant's. No divider when expanded: the wrapper's
          gap is the only thing between this cluster and the pinned apps.
          On the rail this cluster is a column of circles like the sections
          below it, spaced by the same gap. The overlay drawer skips the New
          Chat button: its floating New Chat pill already owns that action
          in the thumb zone. */}
      <div>
        <AssistantSwitcher
          assistantId={assistantId}
          label={assistantName || t("sideMenuBuiltInNav.yourAssistant")}
          active={isIntelligenceActive}
          collapsed={collapsed}
          onSelect={
            onOpenIntelligence
              ? () => {
                  onOpenIntelligence();
                  onClose?.();
                }
              : undefined
          }
          onNewConversation={
            variant === "rail" && onStartNewConversation
              ? () => {
                  onStartNewConversation();
                  onClose?.();
                }
              : undefined
          }
          onSwitched={onClose}
          aside={assistantAside}
          beneath={assistantBeneath}
        />
      </div>
      {pinnedApps.length > 0 || showsEmailPin ? (
        <div className={cn("flex flex-col", SIDEBAR_STACK_GAP)}>
          {showsEmailPin ? (
            <EmailNavItem
              assistantId={assistantId}
              collapsed={collapsed}
              onSelect={() => {
                navigate(routes.assistantInbox);
                onClose?.();
              }}
              onUnpin={emailPin.unpin}
            />
          ) : null}
          {pinnedApps.map((app) => (
            <PinnedAppNavItem
              key={app.id}
              app={app}
              collapsed={collapsed}
              active={activeAppId === app.id}
              onUnpin={unpin}
              onSetColor={setColor}
              onOpen={
                onOpenApp
                  ? (appId) => {
                      onOpenApp(appId);
                      onClose?.();
                    }
                  : undefined
              }
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
