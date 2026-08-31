/**
 * The chat's side control: one pill in the Progress / Agents cluster.
 *
 * The single definition of that pill, so the controls cannot drift into
 * different heights or shapes: one surface, one radius, and the same height as
 * a left side-menu row ({@link SIDE_MENU_TILE_SIZE}), so the controls floating
 * over the chat sit on the same vertical rhythm as the navigation across from
 * them.
 *
 * Built on the design library `Button` rather than a bare `<button>` so it
 * keeps the library's focus ring, disabled handling, and tooltip, and so it can
 * still be cloned onto a Radix trigger via `asChild`, which is how every one
 * of these opens its panel (see {@link AdaptivePopover}).
 *
 * `loading` sweeps the whole pill rather than a label, because these controls
 * have no text to sweep. The overlay needs the pill to be a positioned,
 * clipping box, which is why `relative overflow-hidden` is baked in here rather
 * than left to each caller to remember.
 *
 * The sweep is folded into whichever slot the button renders, because `Button`
 * DROPS `children` entirely when `iconOnly` is set: an overlay passed as a
 * child reaches the DOM on a labelled control and never on an icon-only one.
 * Injecting it alongside the glyph makes both behave the same. It still
 * positions against the button rather than the glyph, since the icon slot is a
 * plain `inline-flex` span with no `position`, so `absolute inset-0` resolves
 * to this component's `relative` box.
 */

import type { ComponentProps, ReactNode } from "react";

import { Button, SIDE_MENU_TILE_SIZE } from "@vellumai/design-library";

import { ShimmerSurface } from "@/domains/chat/components/shimmer-surface";
import { cn } from "@/utils/misc";

export interface SideControlButtonProps
  extends Omit<ComponentProps<typeof Button>, "size" | "variant"> {
  /** Sweeps the whole pill while true. */
  loading?: boolean;
  children?: ReactNode;
}

export function SideControlButton({
  loading = false,
  className,
  children,
  iconOnly,
  ...rest
}: SideControlButtonProps) {
  const shimmer = loading ? <ShimmerSurface /> : null;
  return (
    <Button
      variant="ghost"
      active
      {...rest}
      iconOnly={
        iconOnly ? (
          <>
            {iconOnly}
            {shimmer}
          </>
        ) : (
          iconOnly
        )
      }
      // Height comes from the side-menu token rather than a `h-*` utility, so
      // the two can never drift: change the tile size and these follow.
      // `min-w` keeps an icon-only pill circular at that height instead of
      // collapsing to its glyph.
      //
      // Routed through a custom property so a host can retune it without
      // prop-threading through the two controls that render this. The composer
      // row does exactly that: it seats these beside the Relaxed/Balanced
      // pills, which are 32px, and a 36px neighbour there reads as a mistake.
      style={{
        height: `var(--side-control-size, ${SIDE_MENU_TILE_SIZE}px)`,
        minWidth: `var(--side-control-size, ${SIDE_MENU_TILE_SIZE}px)`,
        ...rest.style,
      }}
      className={cn(
        // `border-0` drops the ghost Button's own 1px border: an outline made
        // these read as inset rather than as chips sitting on the surface. No
        // shadow either, for the same reason: the fill alone is the shape.
        "relative overflow-hidden rounded-full border-0 bg-[var(--surface-lift)]",
        className,
      )}
    >
      {children}
      {/* Only reached when there is no `iconOnly`; otherwise the sweep rides
          with the glyph above and this branch is never rendered. */}
      {iconOnly ? null : shimmer}
    </Button>
  );
}
