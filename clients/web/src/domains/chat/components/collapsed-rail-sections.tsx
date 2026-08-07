import {
  CollapsedGroupIcon,
  getGroupIndicatorState,
} from "@/domains/chat/components/collapsed-group-icon";
import { CollapsedGroupFlyout } from "@/domains/chat/components/conversation-rail-flyout";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import { useSectionConversations } from "@/domains/chat/use-section-conversations";
import {
  RECENTS_SECTION_ICON,
  RECENTS_SECTION_LABEL,
  sectionIcon,
} from "@/domains/chat/utils/sidebar-section-icon";
import type { SidebarViewMode } from "@/domains/chat/utils/sidebar-view-mode";
import type { Conversation } from "@/types/conversation-types";

export interface CollapsedRailSectionsProps {
  sections: SidebarSection[];
  /** Owns the section queries; `null` keeps them on the derived rows. */
  assistantId: string | null;
  /** Sidebar view mode; the flat list gets its own rail icon in "all". */
  viewMode: SidebarViewMode;
  /** Every conversation neither pinned nor in a custom group. */
  flatList: Conversation[];
  processingConversationIds?: Set<string>;
  attentionConversationIds?: Set<string>;
}

/**
 * One section's rail icon.
 *
 * Its own component because it mounts {@link useSectionConversations}, and a
 * `.map` cannot call a hook. It shares a query key with the section's
 * expanded card, so the two read one cache entry rather than fetching twice.
 *
 * Reading the section's own rows is the point: the indicator and the flyout
 * then describe every member, including the ones that never reached the
 * foreground page.
 */
function CollapsedRailSectionIcon({
  section,
  assistantId,
  processingConversationIds,
  attentionConversationIds,
}: {
  section: SidebarSection;
  assistantId: string | null;
  processingConversationIds?: Set<string>;
  attentionConversationIds?: Set<string>;
}) {
  const conversations = useSectionConversations(assistantId, section);
  return (
    <CollapsedGroupIcon
      icon={sectionIcon(section)}
      label={section.label}
      disabled={conversations.length === 0}
      indicatorState={getGroupIndicatorState(
        conversations,
        processingConversationIds,
        attentionConversationIds,
      )}
    >
      {(close, scrollParent) => (
        <CollapsedGroupFlyout
          title={section.label}
          conversations={conversations}
          onClosePopover={close}
          scrollParent={scrollParent}
        />
      )}
    </CollapsedGroupIcon>
  );
}

/**
 * The collapsed rail's section list: the same sections in the same order
 * as the expanded sidebar, as flyout icons. Nothing here is type-aware -
 * order and labels come straight from `sections`, so the rail can't drift
 * from the expanded list the way two hand-maintained orders would.
 */
export function CollapsedRailSections({
  sections,
  assistantId,
  viewMode,
  flatList,
  processingConversationIds,
  attentionConversationIds,
}: CollapsedRailSectionsProps) {
  return (
    <div className="flex flex-col items-center gap-2">
      {sections.map((section) => (
        <CollapsedRailSectionIcon
          key={section.key}
          section={section}
          assistantId={assistantId}
          processingConversationIds={processingConversationIds}
          attentionConversationIds={attentionConversationIds}
        />
      ))}
      {/* The flat list has no section of its own to draw, so the rail
          gives it one icon - otherwise the All view's conversations
          would be unreachable while collapsed. */}
      {viewMode === "all" ? (
        <CollapsedGroupIcon
          icon={RECENTS_SECTION_ICON}
          label={RECENTS_SECTION_LABEL}
          disabled={flatList.length === 0}
          indicatorState={getGroupIndicatorState(
            flatList,
            processingConversationIds,
            attentionConversationIds,
          )}
        >
          {(close, scrollParent) => (
            <CollapsedGroupFlyout
              title={RECENTS_SECTION_LABEL}
              conversations={flatList}
              onClosePopover={close}
              scrollParent={scrollParent}
            />
          )}
        </CollapsedGroupIcon>
      ) : null}
    </div>
  );
}
