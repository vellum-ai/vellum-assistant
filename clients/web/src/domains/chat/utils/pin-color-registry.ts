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

export interface PinColor {
  id: string;
  hex: string;
}

/** Picker choices, in display order. */
export const PIN_COLORS: readonly PinColor[] = BUNDLED_COMPONENTS.colors;

/**
 * How much of the colour reaches the pill. A wash rather than the solid fill
 * the assistant identity pill wears: that pill sits directly above the pinned
 * apps and is the sidebar's only saturated surface, so four solid pills under
 * it would read as its peers rather than as entries below it.
 *
 * The two steps are the tinted analogue of what an untinted pill already does
 * (`--surface-lift` at rest, `--surface-active` for both hover and current
 * page), so a coloured pill keeps the same two-step ladder rather than
 * inventing a third state.
 */
const WASH_REST = "15%";
const WASH_RAISED = "24%";

/** Hex for a stored colour id, or `undefined` when the pin has no colour. */
export function getPinColorHex(
  id: string | null | undefined,
): string | undefined {
  if (!id) {
    return undefined;
  }
  return PIN_COLORS.find((c) => c.id === id)?.hex;
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
