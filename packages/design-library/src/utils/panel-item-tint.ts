/**
 * Tinted surfaces for `PanelItem`'s pill and `SideMenu.Item`'s tile, built
 * from one colour so every tinted row in a column mixes it the same way.
 *
 * Both shapes read the same tint custom properties, each falling back to an
 * untinted token, so a caller tints a row by declaring them on it (or on an
 * ancestor) and an undeclared row keeps its plain surface.
 */

import type { CustomPropertyStyle } from "./custom-property-style";

/** How much of the colour reaches the surface, at rest and raised. */
export interface PanelItemWash {
  /** Resting mix, as a percentage of the colour. */
  rest: number;
  /** Hover and current-page mix, as a percentage of the colour. */
  raised: number;
}

/**
 * The standard steps, and enough colour to tell tinted rows apart without any
 * of them competing with a solidly filled row above them. One pair for every
 * tinted row in a column, so neighbours are washed to the same depth.
 */
export const PANEL_ITEM_WASH: PanelItemWash = { rest: 15, raised: 24 };

/**
 * A wash of `hex` over `--surface-lift` at two steps: the tinted analogue of
 * what an untinted row already does (`--surface-lift` at rest,
 * `--surface-active` for hover and current page), so a tinted row keeps that
 * ladder instead of inventing a third state.
 *
 * `--panel-item-fg` is deliberately left undeclared: a wash moves the surface
 * too little to need a paired foreground, so the label keeps the same content
 * token every other row uses and stays legible in all three themes. A solid
 * fill does need one, and a caller wanting that declares the properties
 * itself.
 */
export function panelItemWashStyle(
  hex: string,
  { rest, raised }: PanelItemWash = PANEL_ITEM_WASH,
): CustomPropertyStyle {
  const raisedMix = `color-mix(in srgb, ${hex} ${raised}%, var(--surface-lift))`;
  return {
    "--panel-item-bg": `color-mix(in srgb, ${hex} ${rest}%, var(--surface-lift))`,
    "--panel-item-hover": raisedMix,
    "--panel-item-active": raisedMix,
  };
}
