import {
  CollapsedGroupIcon,
  getGroupIndicatorState,
} from "@/domains/chat/components/collapsed-group-icon";
import { CollapsedGroupFlyout } from "@/domains/chat/components/conversation-rail-flyout";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import { useSectionConversations } from "@/domains/chat/use-section-conversations";
import { sectionIcon } from "@/domains/chat/utils/sidebar-section-icon";

export interface CollapsedRailSectionsProps {
  sections: SidebarSection[];
  /** Owns the section queries; `null` keeps them on the derived rows. */
  assistantId: string | null;
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
        section.unread,
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
 *
 * `sections` is the only source a tile may come from, in either view mode:
 * every conversation the rail can reach belongs to some section, so a tile
 * drawn from anywhere else stands beside the section that already holds those
 * rows and draws them a second time.
 */
export function CollapsedRailSections({
  sections,
  assistantId,
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
    </div>
  );
}
