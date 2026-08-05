import {
  SIDEBAR_CHIP_GAP,
  SIDEBAR_ROW_PADDING_X,
  SIDEBAR_SECTION_TITLE_TEXT_CLASSES,
} from "@/components/sidebar-nav-geometry";
import { AssistantNavItem } from "@/domains/chat/components/assistant-nav-item";
import { PinnedAppNavItem } from "@/domains/chat/components/pinned-app-nav-item";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";
import { cn, SideMenu } from "@vellumai/design-library";

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
 * New Chat row beneath it, then the pinned-apps list, separated by a
 * divider. On the rail this lives in the non-scrolling header; on the
 * overlay it renders at the top of the body so the whole menu scrolls as
 * one surface (Figma 6764:6745).
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
  const pinnedApps = usePinnedAppsStore.use.pinnedApps();
  const isCollapsedRail = collapsed && variant === "rail";

  return (
    <>
      {/* The assistant cluster: the avatar-colored assistant row with the
          New Chat row (avatar-tinted, plus + label; icon-only tile on the
          collapsed rail) beneath it, so the identity leads and the action
          hangs off it. No divider when
          expanded; breathing room below instead. On the collapsed rail
          the separator provides the section break, so the margin drops
          and the header's own gap (8px) plus the separator's margin keeps
          the divider ~12px off the cluster (Figma 7257:135812). The
          overlay drawer skips the New Chat row: its floating New Chat
          pill already owns that action in the thumb zone. */}
      <div className={isCollapsedRail ? undefined : "mb-2"}>
        <AssistantNavItem
          assistantId={assistantId}
          label={assistantName || "Your Assistant"}
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
        />
      </div>
      {pinnedApps.length > 0 ? (
        <>
          {/* Not the accordion's "Conversations"/"Pinned" title component: this
              block lives outside `CollapsibleNavSection.Root` entirely (in
              the non-scrolling rail header, or the overlay's top-of-body),
              so it's just the same label styling, non-interactive. */}
          {!isCollapsedRail ? (
            <div
              // Same title treatment as "Pinned"/"Conversations" (collapsible-
              // nav-section.tsx's non-collapsible branch): the mobile
              // text/height/padding classes below aren't decorative, they
              // match that component's, so the two read as one style.
              //
              // The trailing -mb-1/-mb-[10px] shaves off the parent's own
              // gap (8px on the rail, 16px on the overlay): additive since
              // flex `gap` doesn't collapse with margins, so this works in
              // both contexts. Mobile (always the overlay) shaves more,
              // halving the 16px gap to Lucky Dip below instead of the
              // 12px this leaves elsewhere.
              className={cn(
                "flex h-[30px] max-md:h-auto items-center rounded-[6px] py-[6px] max-md:pt-3 max-md:pb-1.5 -mb-1 max-md:-mb-[10px]",
                SIDEBAR_SECTION_TITLE_TEXT_CLASSES,
              )}
              style={{
                paddingLeft: SIDEBAR_ROW_PADDING_X,
                paddingRight: SIDEBAR_ROW_PADDING_X,
                gap: SIDEBAR_CHIP_GAP,
              }}
            >
              Pinned Apps
            </div>
          ) : null}
          <div className="flex flex-col gap-[4px]">
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
          <SideMenu.Separator />
        </>
      ) : null}
      {/* The collapsed rail separates the cluster from the group icons below
          it (Figma 7257:135826). Only when there are no pinned apps: that
          block already closed with a separator, and a second one here would
          stack two rules with nothing between them. */}
      {isCollapsedRail && pinnedApps.length === 0 ? (
        <SideMenu.Separator />
      ) : null}
    </>
  );
}
