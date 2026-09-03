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

import { Inbox } from "lucide-react";

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
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import type { Conversation } from "@/types/conversation-types";

/**
 * The assistant section shows at most five realizations before scrolling
 * within itself: 5 rows at 30px plus the 4px gaps between them. A glanceable
 * stack rather than a feed - the section is a person's short list, not
 * another Chats.
 */
const ASSISTANT_SECTION_MAX_HEIGHT = 5 * 30 + 4 * 4;

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
  /* The accent hex, for inking the header glyph in the avatar's own color
     (the New Chat treatment). Null keeps every other section off the avatar
     query, and a null accent (still-loading avatar, or an image with no
     colour to read) is the case where the glyph falls back to the tertiary
     ink anyway. */
  const { accentHex: avatarAccentHex } = useAssistantAvatar(
    isAssistantSection ? assistantId : null,
  );
  const accentHex = isAssistantSection ? avatarAccentHex : null;

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
      /* The bare Inbox mark inked in the raw avatar accent: exactly the
         treatment the assistant cluster's New Chat plus wears
         (`--panel-item-icon-fg` = the accent hex, undarkened), so the
         section reads as the same family without restating the cluster's
         solid-disc avatar. NOT the eyes: those are the assistant herself
         and stay exclusive to the cluster at the top of the rail. Sized and
         boxed like every other section glyph (12px in the 14px slot), so it
         sits at the same weight and on the same axis as Pinned's and
         Chats'. With no accent (custom-image or still-loading avatar,
         exactly when `accentHex` is null) it falls back to the tertiary ink
         those glyphs wear. */
      iconNode={
        isAssistantSection ? (
          <span className="flex h-[14px] w-[14px] shrink-0 items-center justify-center">
            <Inbox
              size={12}
              aria-hidden
              className={
                accentHex ? undefined : "text-[var(--content-tertiary)]"
              }
              style={accentHex ? { color: accentHex } : undefined}
            />
          </span>
        ) : undefined
      }
      label={label}
      /* The name in the emphasised ink rather than the shared header
         classes' tertiary gray: this header sits on its own tinted surface,
         where the section-family gray reads as disabled instead of quiet.
         Set on the label span, so it overrides by inheritance rather than
         specificity. */
      labelClassName={
        isAssistantSection ? "text-[var(--content-emphasised)]" : undefined
      }
      /* The whole header on its own surface: the New Chat pill's exact wash
         (PANEL_ITEM_WASH rest = a 15% accent mix into --surface-lift),
         spanning glyph, label, unread dot, and chevron edge to edge - one
         pill, not a pill with the controls stranded outside it. 36px stands it at the height of a collapsed side-menu item,
         whose full roundness is likewise half of 36. The glyph keeps the
         pill's own inset, not the flat headers': as a pill standing beside
         the Preferences PanelItem (p-[8px]), its glyph has to start the
         same 8px from the rounded edge, so the shared 12px title inset is
         overridden down to pl-2. The title's vertical padding is zeroed so
         the 36px is this class's to state. */
      headerClassName={
        isAssistantSection
          ? "h-9 rounded-full bg-[color-mix(in_srgb,var(--avatar-accent,var(--surface-lift))_15%,var(--surface-lift))] [&_[data-slot=collapsible-nav-section-title]]:py-0! [&_[data-slot=collapsible-nav-section-title]]:pl-2!"
          : undefined
      }
      /* The one section painted in the assistant's own color, so it reads as
         coming from someone rather than as another bucket. `--avatar-accent`
         is published on `<html>` by `useAvatarAccentVar` and is *absent* for
         custom-image and still-loading avatars, so the fallback has to be the
         surface itself: mixing a percentage of `--surface-lift` into
         `--surface-lift` is exactly `--surface-lift`, which is what every
         other card paints. A `transparent` fallback would instead punch a
         hole in the card. The mix is the same 15% the header pill wears
         (the New Chat wash), so header and content share one surface and
         the card reads as a single tinted object rather than a pill on a
         deeper slab; still short of reading as selected, so the rows on
         top read as ordinary rows.

         `mt-auto` is the anchor half of the section's bottom pin. The order
         pin (`pinAssistantSectionLast`) makes it the last card, but only the
         last *space-claiming* section grows to fill the rail, and when that
         section is collapsed nothing does - the leftover height would open
         below this card and float it mid-rail. Auto margin sends that
         leftover above it instead, so the card sits against the Preferences
         footer whatever the sections above are doing; when a grown section
         has already consumed the leftover, there is no free space and the
         margin is inert. */
      cardClassName={
        isAssistantSection
          ? "mt-auto bg-[color-mix(in_srgb,var(--avatar-accent,var(--surface-lift))_15%,var(--surface-lift))]"
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
      maxHeight={isAssistantSection ? ASSISTANT_SECTION_MAX_HEIGHT : undefined}
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
          <AssistantSectionEmptyState />
        ) : undefined
      }
    />
  );
}
