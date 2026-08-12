import type { ComponentProps } from "react";

import { cn } from "../utils/cn";

/**
 * One cell with every child stacked in it, for two occupants that trade
 * places: a status dot and the "…" menu that replaces it on hover, a count
 * and the action that supersedes it. Each child fades on its own conditions
 * and they exchange in the same spot instead of sitting side by side.
 *
 * Grid rather than absolute positioning: both occupants stay in the layout,
 * so the cell sizes itself from the wider of the two and a control inside it
 * is still keyboard reachable (`focus-within` cannot fire on a
 * `display:none` element).
 *
 * This owns placement only. Which occupant is visible at which moment is the
 * caller's, expressed as opacity on the children themselves.
 */
function CrossfadeStack({
  className,
  children,
  ...props
}: ComponentProps<"span">) {
  return (
    <span
      data-slot="crossfade-stack"
      className={cn(
        "grid shrink-0 place-items-center [&>*]:[grid-area:1/1]",
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

export { CrossfadeStack };
