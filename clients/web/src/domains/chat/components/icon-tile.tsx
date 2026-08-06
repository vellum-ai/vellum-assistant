import { type ComponentProps } from "react";

import { Tooltip } from "@vellumai/design-library";
import { cn } from "@vellumai/design-library/utils/cn";

/**
 * Icon tile shared by the collapsed sidebar rail
 * ({@link CollapsedGroupIcon}) and the group-icon picker in the group
 * name dialog: one primitive so the two surfaces can't drift. Wraps the
 * design-library {@link Tooltip} and renders a token-styled button.
 *
 * `shape` is the only geometry switch. The rail is round, because a
 * collapsed rail is a column of circles; the picker is square, because a
 * grid of selectable icons reads as tiles. Everything else, including the
 * tooltip, the hover and active treatment, and the disabled state, is the
 * same either way.
 *
 * Active-state styling rides on ARIA attributes so callers express state
 * semantically: `aria-expanded` (rail tile with its popover open) and
 * `aria-pressed` (picker tile currently selected) share the active
 * surface treatment; the pressed form adds a ring so a selection reads
 * without hover.
 *
 * Extra props (including `ref`, `onClick`, and Radix trigger props from
 * an `asChild` parent) spread onto the underlying `<button>`.
 */
const SHAPE_CLASSES = {
  square: "rounded-[6px]",
  round: "rounded-full",
} as const;

export interface IconTileProps extends ComponentProps<"button"> {
  /** Tooltip content and accessible label. */
  label: string;
  side?: ComponentProps<typeof Tooltip>["side"];
  /**
   * Tile geometry. Square for a picker grid, round for the collapsed rail.
   * @default "square"
   */
  shape?: keyof typeof SHAPE_CLASSES;
}

export function IconTile({
  label,
  side,
  shape = "square",
  className,
  children,
  ...props
}: IconTileProps) {
  return (
    <Tooltip content={label} side={side}>
      <button
        type="button"
        aria-label={label}
        className={cn(
          "relative flex h-[30px] w-[30px] cursor-pointer items-center justify-center text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-hover)]",
          SHAPE_CLASSES[shape],
          "aria-[expanded=true]:bg-[var(--surface-active)] aria-[expanded=true]:text-[var(--content-default)]",
          "aria-[pressed=true]:bg-[var(--surface-active)] aria-[pressed=true]:text-[var(--content-default)] aria-[pressed=true]:ring-1 aria-[pressed=true]:ring-[var(--border-active)]",
          // A tile with nothing to open still occupies its slot, so it keeps
          // the geometry and drops only the affordances.
          "disabled:cursor-default disabled:text-[var(--content-disabled)] disabled:hover:bg-transparent",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  );
}
