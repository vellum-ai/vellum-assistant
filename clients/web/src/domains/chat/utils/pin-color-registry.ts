/**
 * Pinned-app colour registry: the single source of truth for the colours a
 * user can assign to a pinned app in the sidebar, keyed by the stable id
 * stored on the pin.
 *
 * Mirrors the group-icon registry (`./group-icon-registry`): map a stored id
 * to a value once, and every surface (expanded pill, collapsed rail tile, the
 * picker) resolves through it. Ids are the assistant avatar palette's, so a
 * pin and an assistant identity that share an id are the same hue; an unknown
 * or absent id resolves to no tint, which is also what an uncoloured pin
 * stores.
 *
 * Sourced from the bundled copy of the avatar palette rather than
 * `useAssistantAvatar`, because a sidebar row paints on first render and the
 * picker opens inside a context menu. Neither can wait on a fetch.
 */

import type { CSSProperties } from "react";
import { panelItemWashStyle } from "@vellumai/design-library";

import { BUNDLED_COLORS } from "@/utils/avatar-bundled-colors";

/**
 * The name each colour is announced by, as a catalog key rather than the
 * stored id: a user hears a colour name, and "teal" is an internal identifier
 * that happens to be an English word.
 *
 * This map, not the palette, decides which colours the picker offers:
 * {@link PinColorId} is derived from it and {@link PIN_COLORS} is the palette
 * narrowed to it. So every swatch has a name by construction and none can fall
 * back to announcing its own id. A palette colour with no entry here is left
 * out rather than caught by the compiler, which is the trade {@link PIN_COLORS}
 * describes.
 */
const COLOR_NAME_KEYS = {
  green: "pinnedAppColorSwatches.colors.green",
  orange: "pinnedAppColorSwatches.colors.orange",
  pink: "pinnedAppColorSwatches.colors.pink",
  purple: "pinnedAppColorSwatches.colors.purple",
  teal: "pinnedAppColorSwatches.colors.teal",
  yellow: "pinnedAppColorSwatches.colors.yellow",
} as const;

export type PinColorId = keyof typeof COLOR_NAME_KEYS;

export interface PinColor {
  id: PinColorId;
  hex: string;
}

/** Catalog key for a colour's name. */
export function pinColorNameKey(
  id: PinColorId,
): (typeof COLOR_NAME_KEYS)[PinColorId] {
  return COLOR_NAME_KEYS[id];
}

/**
 * Picker choices, in the palette's own order.
 *
 * A palette colour this client has no name for is left out rather than shown
 * under its id: a swatch nobody can hear the name of is worse than one fewer
 * choice, and the omission is loud enough to fix because the colour simply
 * does not appear.
 */
export const PIN_COLORS: readonly PinColor[] = BUNDLED_COLORS.filter(
  (color): color is PinColor => color.id in COLOR_NAME_KEYS,
);

const HEX_BY_ID: ReadonlyMap<string, string> = new Map(
  PIN_COLORS.map((color) => [color.id, color.hex]),
);

/** Hex for a stored colour id, or `undefined` when the registry has no such colour. */
export function getPinColorHex(
  id: string | null | undefined,
): string | undefined {
  return id ? HEX_BY_ID.get(id) : undefined;
}

/**
 * The pin's wash as `PanelItem`'s tint properties, or `undefined` when the pin
 * has no (or an unrecognised) colour. In that case neither the pill nor the
 * collapsed rail's tile sees a declaration and both fall back to their plain
 * surface.
 *
 * A wash rather than a solid fill, because the assistant identity pill sits
 * directly above the pinned apps and is the sidebar's only saturated surface:
 * solid pills under it read as its peers rather than as entries below it.
 */
export function pinTintStyle(
  id: string | null | undefined,
): CSSProperties | undefined {
  const hex = getPinColorHex(id);
  if (!hex) {
    return undefined;
  }
  return panelItemWashStyle(hex);
}
