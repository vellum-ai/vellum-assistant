import { SIDEBAR_STACK_GAP } from "@/components/sidebar-nav-geometry";
import { AssistantSwitcher } from "@/domains/chat/components/assistant-switcher";
import { PinnedAppNavItem } from "@/domains/chat/components/pinned-app-nav-item";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import { cn } from "@vellumai/design-library";
import { useTranslation } from "@/i18n";

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
}

/**
 * The sidebar's built-in navigation block: the assistant cluster with the
 * New Chat row beneath it, then the pinned-apps list. On the rail this lives
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
}: SideMenuBuiltInNavProps) {
  const { t } = useTranslation("chat");
  const pinnedApps = usePinnedAppsStore.use.pinnedApps();

  /* One column at a single gap, rather than each cluster spacing itself.
     `SideMenu.Header` puts its own gap between its children, so a margin
     here would add to that and the block would space its two clusters at
     16px while spacing the pinned apps inside one of them at 4px. Wrapping
     makes the whole block one header child, so this gap is the only one
     between any two entries. */
  return (
    <div className={cn("flex flex-col", SIDEBAR_STACK_GAP)}>
      {/* The assistant cluster: the avatar-colored assistant row with the
          New Chat row (avatar-tinted, plus + label; icon-only tile on the
          collapsed rail) beneath it, so the identity leads and the action
          hangs off it. No divider when expanded: the wrapper's gap is the
          only thing between this cluster and the pinned apps. On the
          rail this cluster is a column of circles like the sections below
          it, spaced by the same gap. The
          overlay drawer skips the New Chat row: its floating New Chat
          pill already owns that action in the thumb zone. */}
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
        />
      </div>
      {pinnedApps.length > 0 ? (
        <div className={cn("flex flex-col", SIDEBAR_STACK_GAP)}>
          {pinnedApps.map((app) => (
            <PinnedAppNavItem
              key={app.appId}
              app={app}
              collapsed={collapsed}
              active={activeAppId === app.appId}
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
