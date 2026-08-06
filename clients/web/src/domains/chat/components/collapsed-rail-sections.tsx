import {
  CollapsedGroupIcon,
  getGroupIndicatorState,
} from "@/domains/chat/components/collapsed-group-icon";
import { CollapsedGroupFlyout } from "@/domains/chat/components/conversation-rail-flyout";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import {
  RECENTS_SECTION_ICON,
  RECENTS_SECTION_LABEL,
  sectionIcon,
} from "@/domains/chat/utils/sidebar-section-icon";
import type { SidebarViewMode } from "@/domains/chat/utils/sidebar-view-mode";
import type { Conversation } from "@/types/conversation-types";

export interface CollapsedRailSectionsProps {
  sections: SidebarSection[];
  /** Sidebar view mode; the flat list gets its own rail icon in "all". */
  viewMode: SidebarViewMode;
  /** Every conversation neither pinned nor in a custom group. */
  flatList: Conversation[];
  processingConversationIds?: Set<string>;
  attentionConversationIds?: Set<string>;
}

/**
 * The collapsed rail's section list: the same sections in the same order
 * as the expanded sidebar, as flyout icons. Nothing here is type-aware -
 * order and labels come straight from `sections`, so the rail can't drift
 * from the expanded list the way two hand-maintained orders would.
 */
export function CollapsedRailSections({
  sections,
  viewMode,
  flatList,
  processingConversationIds,
  attentionConversationIds,
}: CollapsedRailSectionsProps) {
  return (
    <div className="flex flex-col items-center gap-2">
      {sections.map((section) => (
        <CollapsedGroupIcon
          key={section.key}
          icon={sectionIcon(section)}
          label={section.label}
          disabled={section.all.length === 0}
          indicatorState={getGroupIndicatorState(
            section.all,
            processingConversationIds,
            attentionConversationIds,
          )}
        >
          {(close, scrollParent) => (
            <CollapsedGroupFlyout
              title={section.label}
              conversations={section.all}
              onClosePopover={close}
              scrollParent={scrollParent}
            />
          )}
        </CollapsedGroupIcon>
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
