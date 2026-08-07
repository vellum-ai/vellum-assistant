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
 * Sourced from the bundled copy of the character components rather than
 * `useAssistantAvatar`, because a sidebar row paints on first render and the
 * picker opens inside a context menu. Neither can wait on a fetch.
 */

import type { CSSProperties } from "react";

import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

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
export const PIN_COLORS: readonly PinColor[] = BUNDLED_COMPONENTS.colors.filter(
  (color): color is PinColor => color.id in COLOR_NAME_KEYS,
);

const HEX_BY_ID: ReadonlyMap<string, string> = new Map(
  PIN_COLORS.map((color) => [color.id, color.hex]),
);

/**
 * How much of the colour reaches the pill. A wash rather than a solid fill,
 * because the assistant identity pill sits directly above the pinned apps and
 * is the sidebar's only saturated surface: solid pills under it read as its
 * peers rather than as entries below it.
 *
 * Two steps, the tinted analogue of what an untinted pill already does
 * (`--surface-lift` at rest, `--surface-active` for hover and current page),
 * so a coloured pill keeps that ladder instead of inventing a third state.
 */
const WASH_REST = "15%";
const WASH_RAISED = "24%";

/** Hex for a stored colour id, or `undefined` when the registry has no such colour. */
export function getPinColorHex(
  id: string | null | undefined,
): string | undefined {
  return id ? HEX_BY_ID.get(id) : undefined;
}

/**
 * The three tint custom properties `PanelItem`'s pill and `SideMenu.Item`'s
 * tile both read, or `undefined` when the pin has no (or an unrecognised)
 * colour. In that case neither shape sees a declaration and both fall back to
 * their plain surface.
 *
 * `--panel-item-fg` is deliberately left undeclared: a 15% wash moves the
 * surface too little to need a paired foreground, so the label keeps the same
 * content token every other row uses and stays legible in all three themes.
 */
export function pinTintStyle(
  id: string | null | undefined,
): CSSProperties | undefined {
  const hex = getPinColorHex(id);
  if (!hex) {
    return undefined;
  }
  const raised = `color-mix(in srgb, ${hex} ${WASH_RAISED}, var(--surface-lift))`;
  return {
    "--panel-item-bg": `color-mix(in srgb, ${hex} ${WASH_REST}, var(--surface-lift))`,
    "--panel-item-hover": raised,
    "--panel-item-active": raised,
  } as CSSProperties;
}
