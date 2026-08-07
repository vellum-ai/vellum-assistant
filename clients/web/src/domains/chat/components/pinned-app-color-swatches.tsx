import { Ban, Check } from "lucide-react";

import { cn, ContextMenu } from "@vellumai/design-library";

import {
  getPinColorHex,
  PIN_COLORS,
} from "@/domains/chat/utils/pin-color-registry";
import { contrastForeground } from "@/utils/avatar-tone";

/**
 * The colour row inside a pinned app's context menu: a "no colour" tile
 * followed by one swatch per registry colour, laid out as a single wrapping
 * row above the menu's ordinary items.
 *
 * A row rather than the dialog the group icon picker opens, because there is
 * no name field for it to sit beside. One press sets the colour, and the same
 * row is what a long press reaches on touch, so the interaction needs no
 * second path.
 *
 * Each swatch is a real `ContextMenu.Item`. Radix's roving focus only reaches
 * items, so plain buttons here would be unreachable by keyboard; as items the
 * arrow keys walk the swatches in DOM order, along the row and then on to the
 * items below it. The colour rides on an inner dot rather than on the item
 * itself, so the item's own highlight surface stays visible behind it.
 *
 * The current colour is marked with a glyph inside its own dot rather than a
 * ring around it. An item lays its children inside a clipping box, so a ring
 * drawn outside the dot loses its top and bottom to the overflow; a glyph
 * within the dot is also the louder marker at this size. It carries the
 * foreground {@link contrastForeground} pairs with that colour, which is what
 * keeps it legible on the light swatches as well as the dark ones.
 */
export interface PinnedAppColorSwatchesProps {
  /** The pin's current colour id, or `undefined` when it has none. */
  value: string | undefined;
  onChange: (color: string | null) => void;
}

/** A square tile with no label to make room for, at the menu's item rhythm. */
const SWATCH_ITEM_CLASSES = "h-7 w-7 shrink-0 justify-center p-0";

const DOT_CLASSES =
  "mx-auto flex h-4 w-4 items-center justify-center rounded-full";

export function PinnedAppColorSwatches({
  value,
  onChange,
}: PinnedAppColorSwatchesProps) {
  /* A colour the registry no longer knows resolves to no tint, so the row
     shows "no colour" as the selection, matching what the pill is painting. */
  const selected = getPinColorHex(value) ? value : undefined;

  return (
    <div className="flex flex-wrap items-center gap-1 px-1 pb-1">
      <ContextMenu.Item
        aria-label={selected === undefined ? "No color, selected" : "No color"}
        className={SWATCH_ITEM_CLASSES}
        onSelect={() => onChange(null)}
      >
        <span className={cn(DOT_CLASSES, "border border-[var(--border-base)]")}>
          {selected === undefined ? (
            <Check size={10} aria-hidden />
          ) : (
            <Ban
              size={10}
              aria-hidden
              className="text-[var(--content-tertiary)]"
            />
          )}
        </span>
      </ContextMenu.Item>
      {PIN_COLORS.map((color) => (
        <ContextMenu.Item
          key={color.id}
          aria-label={
            selected === color.id ? `${color.id}, selected` : color.id
          }
          className={SWATCH_ITEM_CLASSES}
          onSelect={() => onChange(color.id)}
        >
          <span className={DOT_CLASSES} style={{ backgroundColor: color.hex }}>
            {selected === color.id ? (
              <Check
                size={10}
                aria-hidden
                style={{ color: contrastForeground(color.hex) }}
              />
            ) : null}
          </span>
        </ContextMenu.Item>
      ))}
    </div>
  );
}
