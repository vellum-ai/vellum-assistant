import { type ComponentProps } from "react";

import { Tooltip } from "@vellumai/design-library";
import { cn } from "@vellumai/design-library/utils/cn";

/**
 * Square icon tile shared by the collapsed sidebar rail
 * ({@link CollapsedGroupIcon}) and the group-icon picker in the group
 * name dialog: one primitive so the two surfaces can't drift. Wraps the
 * design-library {@link Tooltip} and renders a token-styled button.
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
export interface IconTileProps extends ComponentProps<"button"> {
  /** Tooltip content and accessible label. */
  label: string;
  side?: ComponentProps<typeof Tooltip>["side"];
}

export function IconTile({
  label,
  side,
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
          "relative flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-[6px] text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-hover)]",
          "aria-[expanded=true]:bg-[var(--surface-active)] aria-[expanded=true]:text-[var(--content-default)]",
          "aria-[pressed=true]:bg-[var(--surface-active)] aria-[pressed=true]:text-[var(--content-default)] aria-[pressed=true]:ring-1 aria-[pressed=true]:ring-[var(--border-active)]",
          className,
        )}
        {...props}
      >
        {children}
      </button>
    </Tooltip>
  );
}
