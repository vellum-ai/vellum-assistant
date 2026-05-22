import type { ReactNode } from "react";

import { CollapsibleNavSection } from "@/components/collapsible-nav-section.js";
import { PanelItem, SideMenu } from "@vellum/design-library";
import type { Conversation } from "@/domains/chat/api/conversations.js";
import type { SubGroup } from "@/domains/chat/utils/sub-group-utils.js";
import { countBadge } from "@/domains/chat/components/sidebar-count-badge.js";

// ---------------------------------------------------------------------------
// SubGroupAccordion — shared sub-accordion for Background + Scheduled
// ---------------------------------------------------------------------------

interface SubGroupAccordionProps {
  subGroups: SubGroup[];
  isSingleRow: (group: SubGroup) => boolean;
  activeConversationKey?: string;
  attentionConversationKeys?: Set<string>;
  onSelectConversation: (key: string) => void;
  renderActions: (conversation: Conversation) => ReactNode;
  renderPinToggle: (conversation: Conversation) => ReactNode;
  renderRow: (conversation: Conversation, panelItem: ReactNode) => ReactNode;
}

export function SubGroupAccordion({
  subGroups,
  isSingleRow,
  activeConversationKey,
  attentionConversationKeys,
  onSelectConversation,
  renderActions,
  renderPinToggle,
  renderRow,
}: SubGroupAccordionProps) {
  return (
    <div className="flex flex-col gap-2">
      {subGroups.map((group) => {
        if (isSingleRow(group)) {
          const c = group.conversations[0];
          if (!c) return null;
          return renderRow(
            c,
            <PanelItem
              leadingSlot={renderPinToggle(c)}
              label={c.title ?? "Untitled"}
              marqueeOnHover
              active={c.conversationKey === activeConversationKey}
              onSelect={() => onSelectConversation(c.conversationKey)}
              trailingAction={renderActions(c)}
            />,
          );
        }
        const groupHasAttention = attentionConversationKeys
          ? group.conversations.some(c => attentionConversationKeys.has(c.conversationKey))
          : false;
        return (
          <CollapsibleNavSection.Root
            key={group.key}
            type="multiple"
            className="gap-0"
            {...(groupHasAttention ? { value: [group.key] } : {})}
          >
            <CollapsibleNavSection.Section
              value={group.key}
              label={group.label}
              trailing={countBadge(group.conversations.length)}
            >
              <SideMenu.SubList>
                {group.conversations.map((c) =>
                  renderRow(
                    c,
                    <PanelItem
                      leadingSlot={renderPinToggle(c)}
                      label={c.title ?? "Untitled"}
                      marqueeOnHover
                      active={c.conversationKey === activeConversationKey}
                      onSelect={() => onSelectConversation(c.conversationKey)}
                      trailingAction={renderActions(c)}
                    />,
                  ),
                )}
              </SideMenu.SubList>
            </CollapsibleNavSection.Section>
          </CollapsibleNavSection.Root>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BackgroundSubGroups / ScheduledSubGroups
// ---------------------------------------------------------------------------

interface CategorySubGroupsProps {
  subGroups: SubGroup[];
  activeConversationKey?: string;
  attentionConversationKeys?: Set<string>;
  onSelectConversation: (key: string) => void;
  renderActions: (conversation: Conversation) => ReactNode;
  renderPinToggle: (conversation: Conversation) => ReactNode;
  renderRow: (conversation: Conversation, panelItem: ReactNode) => ReactNode;
}

export function BackgroundSubGroups(props: CategorySubGroupsProps) {
  return (
    <SubGroupAccordion
      subGroups={props.subGroups}
      isSingleRow={(g) => g.key.startsWith("__single__:")}
      activeConversationKey={props.activeConversationKey}
      attentionConversationKeys={props.attentionConversationKeys}
      onSelectConversation={props.onSelectConversation}
      renderActions={props.renderActions}
      renderPinToggle={props.renderPinToggle}
      renderRow={props.renderRow}
    />
  );
}

export function ScheduledSubGroups(props: CategorySubGroupsProps) {
  return (
    <SubGroupAccordion
      subGroups={props.subGroups}
      isSingleRow={(g) => g.conversations.length === 1}
      activeConversationKey={props.activeConversationKey}
      attentionConversationKeys={props.attentionConversationKeys}
      onSelectConversation={props.onSelectConversation}
      renderActions={props.renderActions}
      renderPinToggle={props.renderPinToggle}
      renderRow={props.renderRow}
    />
  );
}
