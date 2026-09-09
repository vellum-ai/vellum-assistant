/**
 * The 3px dot that separates a title from the count or meta beside it. Panel
 * headers, chat chips, card surfaces, and list rows all draw it, so it sits
 * above any one of their shells. `packages/design-library`'s
 * `list-row.stories.tsx` keeps its own copy of the span, since the package
 * cannot import from the app.
 */

import { cn } from "@/utils/misc";

export function MidlineDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-[3px] shrink-0 rounded-full bg-[var(--content-tertiary)]",
        className,
      )}
    />
  );
}
