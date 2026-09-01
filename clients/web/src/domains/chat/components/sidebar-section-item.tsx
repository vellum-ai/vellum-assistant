/**
 * One sidebar conversation section, whatever its type.
 *
 * This is the single render path for Pinned, Chats, every origin-channel
 * section, and every custom group - which is what keeps their spacing and
 * header treatment identical and lets the user interleave them freely
 * (LUM-2909).
 *
 * Nothing about the *shell* varies by type. Every section gets the same card,
 * the same header, the same hover "…", and the same drag wiring, all resolved
 * before they reach here. What varies is only what goes *in* the menu, and that
 * is `sectionMenu`'s answer in `assistant-side-menu.tsx`, not this component's:
 * a custom group adds rename/delete/copy-id, Chats and the channel sections add
 * the channel-grouping toggle.
 *
 * The row list is the one real exception: every section caps and scrolls
 * within itself, except Pinned (grows to fit its own rows instead, see
 * `unbounded` on `ConversationRowList`) and the bottom-most section (claims
 * whatever space the sidebar has left instead of a fixed cap, see `isLast`).
 */

import type { ReactNode } from "react";

import type { CollapsibleNavSectionDrag } from "@/components/collapsible-nav-section";
import { AssistantSectionEmptyState } from "@/domains/chat/components/assistant-section-empty-state";
import { SidebarSectionCard } from "@/domains/chat/components/sidebar-section-card";
import {
  GroupActionsMenu,
  type GroupMenuItemsProps,
} from "@/domains/chat/components/group-actions-menu";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import { useSectionConversations } from "@/domains/chat/use-section-conversations";
import {
  assistantSectionLabel,
  sectionIcon,
} from "@/domains/chat/utils/sidebar-section-icon";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import type { Conversation } from "@/types/conversation-types";

export interface SidebarSectionItemProps {
  section: SidebarSection;
  /** Owns this section's query; `null` keeps it on the derived rows. */
  assistantId: string | null;
  /**
   * Header actions, given the section's own rows. A function rather than a
   * built menu because the rows are resolved here: the sidebar decides what
   * the bulk actions *are*, this decides what they act on. `getAllRows` is
   * how the bulk actions cover every member when the rendered rows are a
   * window (LUM-2444): it drains the section at click time, so "mark all
   * read" reaches rows the user never scrolled to.
   */
  groupMenu: (
    conversations: Conversation[],
    getAllRows: () => Promise<Conversation[]>,
  ) => GroupMenuItemsProps;
  /** Section drag-reorder wiring; omit to pin the section in place. */
  drag?: CollapsibleNavSectionDrag;
  /** Activity dot shown in the header only while the section is collapsed. */
  collapsedIndicator?: (
    conversations: Conversation[],
    section: SidebarSection,
  ) => ReactNode;
  /**
   * Whether this is the bottom-most section in the list. Only it claims the
   * sidebar's leftover space when open; every section above it always sizes
   * to its own content (capped and scrolling internally past a point), since
   * flex-grow has no notion of "this one actually needs the room" - handing
   * every open section a share stretched a two-row group into a mostly-empty
   * box the same size as a busy one beside it.
   */
  isLast?: boolean;
}

export function SidebarSectionItem({
  section,
  assistantId,
  groupMenu: buildGroupMenu,
  drag,
  collapsedIndicator,
  isLast,
}: SidebarSectionItemProps) {
  const { conversations, hasMore, loadMore, getAllRows } =
    useSectionConversations(assistantId, section);
  /* Read here rather than threaded down from the side menu: only one section
     wants the name, and the same store is what the layout above reads. */
  const assistantName = useAssistantIdentityStore.use.name();
  const isAssistantSection = section.type === "assistant";

  /* Every section handed to this component renders. Whether a section exists
     at all is `use-sidebar-state`'s answer, and it has to stay the only one:
     the move-up/move-down nudges count entries in that list, so a section that
     is present but returns `null` here offers a move that swaps with something
     off screen.

     One predicate for membership and visibility, or the two drift and this
     recurs at the next section type. */
  const groupMenu = buildGroupMenu(conversations, getAllRows);
  const label = isAssistantSection
    ? assistantSectionLabel(assistantName)
    : section.label;
  return (
    <SidebarSectionCard
      value={section.key}
      icon={sectionIcon(section)}
      label={label}
      /* The one section painted in the assistant's own color, so it reads as
         coming from someone rather than as another bucket. `--avatar-accent`
         is published on `<html>` by `useAvatarAccentVar` and is *absent* for
         custom-image and still-loading avatars, so the fallback has to be the
         surface itself: mixing a percentage of `--surface-lift` into
         `--surface-lift` is exactly `--surface-lift`, which is what every
         other card paints. A `transparent` fallback would instead punch a
         hole in the card. Kept low (7%) because this sits behind
         conversation rows that still have to read as ordinary rows. */
      cardClassName={
        isAssistantSection
          ? "bg-[color-mix(in_srgb,var(--avatar-accent,var(--surface-lift))_7%,var(--surface-lift))]"
          : undefined
      }
      /* The "…" button and the header's right-click menu both render from
         `groupMenu`. Every section carries it: a section's actions should not
         depend on which kind it is, and Chats and the channels have their own
         (the channel-grouping toggle) on top of the bulk ones. */
      trailing={<GroupActionsMenu label={section.label} {...groupMenu} />}
      groupMenu={groupMenu}
      collapsedIndicator={collapsedIndicator?.(conversations, section)}
      drag={drag}
      // Pinned collapses like every other section (one component, one
      // behavior; its open state defaults open and persists like the
      // rest). It is the one section that never caps/scrolls internally:
      // it grows to fit its own rows instead.
      unbounded={section.type === "pinned"}
      isLast={isLast}
      items={conversations}
      onEndReached={hasMore ? loadMore : undefined}
      /* The only section that renders at zero, so the only one with anything
         to say there. `ConversationNavSection` resolves this as
         `children ?? <ConversationRowList/>`, so it has to be exactly
         `undefined` in every other case or a section would lose its rows to
         an empty node. Passed as a prop rather than as a JSX child for that
         reason: it keeps the absent case unambiguous. */
      children={
        isAssistantSection && conversations.length === 0 ? (
          <AssistantSectionEmptyState assistantId={assistantId} />
        ) : undefined
      }
    />
  );
}
