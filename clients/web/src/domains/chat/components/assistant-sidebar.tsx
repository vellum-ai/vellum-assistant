/**
 * The assistant sidebar: pills on top, a card per section, a pill at the
 * bottom.
 *
 * Purely presentational. It takes the sections it should draw and knows
 * nothing about where they came from, which is what lets every section load
 * from its own server-filtered query (LUM-2443). A section is a card here and
 * a circle on the collapsed rail, from the same entry, so the two surfaces
 * cannot disagree about what exists or what order it is in.
 *
 * Composition, not layout: {@link SideMenu} owns the surface and the resize
 * behavior, {@link SidebarSectionCard} owns a section, and
 * {@link SidebarNavPill} owns an entry and its two shapes. Nothing here draws
 * a control of its own.
 *
 * Sections and pills both arrive as data rather than as markup, for the same
 * reason: each is drawn two ways, as a card or pill when expanded and as a
 * circle on the rail. Handing this component rendered nodes would mean the
 * caller building both and the two drifting.
 */

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { SideMenu } from "@vellumai/design-library";

import { CollapsibleNavSection } from "@/components/collapsible-nav-section";
import {
  CollapsedGroupIcon,
  GroupIndicatorDot,
  type GroupIndicatorState,
} from "@/domains/chat/components/collapsed-group-icon";
import { CollapsedGroupFlyout } from "@/domains/chat/components/conversation-rail-flyout";
import type { GroupMenuItemsProps } from "@/domains/chat/components/group-actions-menu";
import { SidebarNavPillList } from "@/domains/chat/components/sidebar-nav-pill-list";
import type { SidebarNavPillProps } from "@/domains/chat/components/sidebar-nav-pill";
import { SidebarSectionCard } from "@/domains/chat/components/sidebar-section-card";
import type { Conversation } from "@/types/conversation-types";

/**
 * One nav entry above or below the sections, as data. `SidebarNavPill` draws
 * it as a pill or a circle depending on the sidebar, so callers describe the
 * entry and never its shape.
 */
export interface AssistantSidebarPill
  extends Omit<SidebarNavPillProps, "collapsed"> {
  key: string;
}

export interface AssistantSidebarSection {
  /** Collapse key and React key. Stable across renders. */
  key: string;
  /** Header label, e.g. "Pinned", "Car Chat", "Chats". */
  label: string;
  /** Section glyph, shown in the header and on the collapsed rail tile. */
  icon: LucideIcon;
  /** The section's rows. */
  items: Conversation[];
  /** This section's own actions, reachable by right-click and long-press. */
  groupMenu?: GroupMenuItemsProps;
  /** Header control, typically the section's "…" menu. */
  trailing?: ReactNode;
  /**
   * Attention, processing, or unread in this section. One field drives both
   * surfaces: the card shows it in its header while collapsed, and the rail
   * tile overlays it on the icon, so the two cannot report different
   * activity for the same section.
   */
  indicatorState?: GroupIndicatorState;
  /** Grow to fit the rows rather than capping and scrolling within. */
  unbounded?: boolean;
}

export interface AssistantSidebarProps {
  /** Collapse to the icon rail. Ignored by the overlay variant. */
  collapsed?: boolean;
  variant?: "rail" | "overlay";
  width?: number;
  onWidthChange?: (width: number) => void;
  /** Entries above the sections: the assistant, its pinned apps, New Chat. */
  pills?: AssistantSidebarPill[];
  /** Entries pinned to the bottom, e.g. Preferences. */
  footer?: AssistantSidebarPill[];
  /** Every section to draw, in the order the user arranged them. */
  sections: AssistantSidebarSection[];
  /** Keys of the open sections. */
  openSections?: string[];
  onOpenSectionsChange?: (next: string[]) => void;
}

export function AssistantSidebar({
  collapsed = false,
  variant = "rail",
  width,
  onWidthChange,
  pills,
  footer,
  sections,
  openSections,
  onOpenSectionsChange,
}: AssistantSidebarProps) {
  const isRail = collapsed && variant === "rail";

  return (
    <SideMenu
      ariaLabel="Assistant navigation"
      collapsed={collapsed}
      variant={variant}
      width={width}
      onWidthChange={onWidthChange}
      className="h-full border-0"
    >
      {pills?.length ? (
        <SideMenu.Header>
          <SidebarNavPillList collapsed={isRail} entries={pills} />
        </SideMenu.Header>
      ) : null}

      <SideMenu.Body className="gap-2">
        {isRail ? (
          <div className="flex flex-col items-center gap-2">
            {sections.map((section) => (
              <CollapsedGroupIcon
                key={section.key}
                icon={section.icon}
                label={section.label}
                disabled={section.items.length === 0}
                indicatorState={section.indicatorState ?? null}
              >
                {(close, scrollParent) => (
                  <CollapsedGroupFlyout
                    title={section.label}
                    conversations={section.items}
                    onClosePopover={close}
                    scrollParent={scrollParent}
                  />
                )}
              </CollapsedGroupIcon>
            ))}
          </div>
        ) : (
          /* One accordion root for every card, so the gap between any two
             sections is the root's and nothing else decides spacing. */
          <CollapsibleNavSection.Root
            type="multiple"
            value={openSections}
            onValueChange={onOpenSectionsChange}
          >
            {sections.map((section) => (
              <SidebarSectionCard
                key={section.key}
                value={section.key}
                label={section.label}
                icon={section.icon}
                items={section.items}
                groupMenu={section.groupMenu}
                trailing={section.trailing}
                collapsedIndicator={
                  <GroupIndicatorDot state={section.indicatorState ?? null} />
                }
                unbounded={section.unbounded}
              />
            ))}
          </CollapsibleNavSection.Root>
        )}
      </SideMenu.Body>

      {footer?.length ? (
        <SideMenu.Footer>
          <SidebarNavPillList collapsed={isRail} entries={footer} />
        </SideMenu.Footer>
      ) : null}
    </SideMenu>
  );
}
