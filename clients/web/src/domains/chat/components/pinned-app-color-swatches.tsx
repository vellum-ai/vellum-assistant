import { Ban, Check } from "lucide-react";

import { cn, ContextMenu } from "@vellumai/design-library";

import {
  getPinColorHex,
  PIN_COLORS,
  pinColorNameKey,
  type PinColorId,
} from "@/domains/chat/utils/pin-color-registry";
import { useTranslation } from "@/i18n";
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
 * The swatches are a single-choice set, so they carry `menuitemradio` and
 * announce their selection through `aria-checked`. That is what a screen
 * reader reads out in the user's own language, rather than this component
 * gluing a word onto a colour's name and leaving it in English. They are also
 * real `ContextMenu.Item`s because Radix's roving focus only reaches items:
 * plain buttons here would be unreachable by keyboard, while as items the
 * arrow keys walk the swatches in DOM order, along the row and then on to the
 * items below it.
 *
 * The colour rides on an inner dot rather than on the item itself, so the
 * item's own highlight surface stays visible behind it. The current colour is
 * marked with a glyph inside its own dot rather than a ring around it: an item
 * lays its children inside a clipping box, so a ring drawn outside the dot
 * loses its top and bottom to the overflow. The glyph carries the foreground
 * {@link contrastForeground} pairs with that colour, which keeps it legible on
 * the light swatches as well as the dark ones.
 */
export interface PinnedAppColorSwatchesProps {
  /**
   * The pin's current colour id, or `undefined` when it has none. Widened to
   * `string` because it arrives from storage, which can hold an id this
   * registry no longer carries.
   */
  value: string | undefined;
  /** `null` clears the colour. Only ever an id this registry knows. */
  onChange: (color: PinColorId | null) => void;
}

/** A square tile with no label to make room for, at the menu's item rhythm. */
const SWATCH_ITEM_CLASSES = "h-7 w-7 shrink-0 justify-center p-0";

const DOT_CLASSES =
  "mx-auto flex h-4 w-4 items-center justify-center rounded-full";

export function PinnedAppColorSwatches({
  value,
  onChange,
}: PinnedAppColorSwatchesProps) {
  const { t } = useTranslation("chat");

  /* A colour the registry no longer knows resolves to no tint, so the row
     shows "no colour" as the selection, matching what the pill is painting. */
  const selected = getPinColorHex(value) ? value : undefined;

  return (
    <div className="flex flex-wrap items-center gap-1 px-1 pb-1">
      <ContextMenu.Item
        role="menuitemradio"
        aria-checked={selected === undefined}
        aria-label={t("pinnedAppColorSwatches.noColor")}
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
          role="menuitemradio"
          aria-checked={selected === color.id}
          aria-label={t(pinColorNameKey(color.id))}
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
