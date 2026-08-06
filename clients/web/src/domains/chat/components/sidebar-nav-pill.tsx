/**
 * One nav entry beside the sidebar's sections: the assistant, a pinned app,
 * New Chat, Preferences.
 *
 * The same entry is drawn two ways. Expanded it is a {@link PanelItem} at
 * pill shape, a capsule that hugs its label. Collapsed it is an
 * {@link IconTile} circle, which is what everything on the rail becomes.
 * Owning both here is the point: a caller passes what the entry *is* and
 * never decides how it looks, so the two shapes cannot drift.
 *
 * Neither shape is drawn by hand. Both are design-library or shared
 * primitives at a geometry variant.
 */

import type { LucideIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import { PanelItem } from "@vellumai/design-library";

import { IconTile } from "@/domains/chat/components/icon-tile";

export interface SidebarNavPillProps {
  /** Entry name: the pill's label, and the circle's tooltip. */
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
  /** Selected state. */
  active?: boolean;
  onSelect?: () => void;
  /** Draw the circle instead of the pill. */
  collapsed?: boolean;
}

export function SidebarNavPill({
  label,
  icon: Icon,
  leadingSlot,
  tint,
  active = false,
  onSelect,
  collapsed = false,
}: SidebarNavPillProps) {
  if (collapsed) {
    return (
      <IconTile
        label={label}
        shape="round"
        side="right"
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
      >
        {leadingSlot ?? (Icon ? <Icon size={14} /> : null)}
      </IconTile>
    );
  }

  return (
    <PanelItem
      shape="pill"
      label={label}
      icon={Icon}
      leadingSlot={leadingSlot}
      active={active}
      onSelect={onSelect}
      style={tint ? ({ "--assistant-tint": tint } as CSSProperties) : undefined}
      className={
        tint
          ? "bg-[color-mix(in_srgb,var(--assistant-tint)_14%,var(--surface-lift))]"
          : undefined
      }
    />
  );
}
