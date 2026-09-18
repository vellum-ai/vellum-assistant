/**
 * A round icon-only button on the sidebar's panel wash: the tile the rail
 * draws for an action that carries the assistant's colour (the
 * Assistant Inbox). The surface reads `PanelItem`'s tint properties
 * (`--panel-item-bg`, `--panel-item-hover`), so a caller that washes an
 * expanded pill washes this with the same declaration, and the glyph reads
 * `--panel-item-icon-fg`, which is how the accent reaches it; a caller that
 * declares nothing gets the plain lifted surface and the tertiary glyph.
 *
 * Not `SideMenu.Item`'s tile: that row pins its glyph to the row ink, so
 * the accent could not reach it, and it is a collapsed-rail affordance only,
 * where this tile also stands on a row at the disc size.
 *
 * Named by its tooltip rather than a label: the accessible name is the
 * `label`, the tooltip repeats it (with anything the caller adds, such as a
 * shortcut hint), and no native `title` doubles the tooltip.
 */

import type { LucideIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

import {
  cn,
  Tooltip,
  type CustomPropertyStyle,
} from "@vellumai/design-library";

export interface SidebarIconTileProps
  extends Omit<ComponentProps<"button">, "style" | "children" | "onClick"> {
  icon: LucideIcon;
  /** The accessible name. */
  label: string;
  /** Tooltip content; the label alone when omitted. */
  tooltip?: ReactNode;
  tooltipSide: "right" | "top";
  /** Diameter, in px: the rail's tile size, or the assistant row's disc size. */
  size: number;
  onSelect?: () => void;
  /** The wash and the glyph's accent, or nothing for the plain surface. */
  style?: CustomPropertyStyle;
}

export function SidebarIconTile({
  icon: Icon,
  label,
  tooltip,
  tooltipSide,
  size,
  onSelect,
  style,
  className,
  ...rest
}: SidebarIconTileProps) {
  return (
    <Tooltip content={tooltip ?? label} side={tooltipSide}>
      <button
        type="button"
        onClick={onSelect}
        aria-label={label}
        className={cn(
          "group relative flex shrink-0 self-center cursor-pointer items-center justify-center overflow-hidden select-none",
          "rounded-full",
          "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
          "transition-colors duration-150 active:scale-[0.98]",
          "bg-[var(--panel-item-bg,var(--surface-lift))]",
          "[@media(hover:hover)]:hover:bg-[var(--panel-item-hover,var(--surface-hover))]",
          className,
        )}
        style={{ ...style, width: size, height: size }}
        {...rest}
      >
        {/* 14px, not the section headers' 12px - a single glyph carries less
            ink than a header's icon-plus-label, so it needs the extra 2px to
            read at the same weight beside them; 16px on a phone, as the
            section toggle draws its glyph. */}
        <Icon
          aria-hidden="true"
          className="size-3.5 max-md:size-4"
          style={{
            color: "var(--panel-item-icon-fg, var(--content-tertiary))",
          }}
        />
      </button>
    </Tooltip>
  );
}
