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
 * Marking the cell (`data-reveal-slot`) is all this does: the stylesheet places
 * the occupants in it and seats them side by side where there is no hover to
 * trade them with. Which occupant is visible at which moment is the caller's,
 * expressed as `data-reveal` and `data-reveal-yield` on the children
 * themselves.
 *
 * A caller that wants the cell to hold a column of slots at one width sets a
 * floor (`min-w-*`), not a fixed size: seated side by side the occupants are
 * wider than either alone, and a fixed width paints the second one outside the
 * row.
 */
function CrossfadeStack({
  className,
  children,
  ...props
}: ComponentProps<"span">) {
  return (
    <span
      data-slot="crossfade-stack"
      data-reveal-slot=""
      className={cn("grid shrink-0 place-items-center", className)}
      {...props}
    >
      {children}
    </span>
  );
}

export { CrossfadeStack };
