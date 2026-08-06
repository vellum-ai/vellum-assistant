/**
 * A column of sidebar nav entries: the assistant, its pinned apps, New Chat,
 * Preferences.
 *
 * Each entry is a {@link PanelItem}, a pill when the sidebar is expanded and
 * a circle when it is collapsed. Collapsing changes the shape and nothing
 * else, so an entry keeps its surface, its hover and active treatment, and
 * its semantics either way.
 *
 * A circle has no room for its label, so it carries a {@link Tooltip}. The
 * label is still the control's accessible name; the tooltip is what gives a
 * sighted user the same information.
 */

import type { LucideIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { PanelItem, Tooltip } from "@vellumai/design-library";

export interface SidebarNavEntry {
  key: string;
  /** The pill's label, the circle's tooltip, and the accessible name of both. */
  label: string;
  /** Glyph, and the whole of the entry once collapsed. */
  icon?: LucideIcon;
  /** Custom leading content, e.g. the assistant's avatar. Overrides `icon`. */
  leadingSlot?: ReactNode;
  /**
   * Avatar color for the assistant's entry, as a hex string. Applies the
   * avatar-tinted wash the assistant row already wears; omit for the neutral
   * surface every other entry uses.
   */
  tint?: string | null;
  active?: boolean;
  onSelect?: () => void;
}

export interface SidebarNavPillListProps {
  entries: SidebarNavEntry[];
  /** Draw the entries as circles rather than pills. */
  collapsed?: boolean;
}

export function SidebarNavPillList({
  entries,
  collapsed = false,
}: SidebarNavPillListProps) {
  return (
    <div
      className={
        collapsed
          ? "flex flex-col items-center gap-2"
          : "flex flex-col items-start gap-1"
      }
    >
      {entries.map(
        ({ key, label, icon, leadingSlot, tint, active, onSelect }) => {
          const item = (
            <PanelItem
              shape={collapsed ? "circle" : "pill"}
              label={label}
              icon={icon}
              leadingSlot={leadingSlot}
              active={active}
              onSelect={onSelect}
              style={
                tint
                  ? ({ "--assistant-tint": tint } as CSSProperties)
                  : undefined
              }
              className={
                tint
                  ? "bg-[color-mix(in_srgb,var(--assistant-tint)_14%,var(--surface-lift))]"
                  : undefined
              }
            />
          );
          return collapsed ? (
            <Tooltip key={key} content={label} side="right">
              {item}
            </Tooltip>
          ) : (
            <span key={key} className="contents">
              {item}
            </span>
          );
        },
      )}
    </div>
  );
}
