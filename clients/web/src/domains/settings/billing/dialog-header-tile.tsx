import type { ReactNode } from "react";

import { cn } from "@/utils/misc";

export interface DialogHeaderTileProps {
  /** The tile's fill, e.g. `bg-[var(--surface-active)]`. */
  className?: string;
  /** Test hook naming which glyph the header resolved to. */
  "data-testid"?: string;
  children?: ReactNode;
}

/**
 * The 52px rounded square behind the package-switch confirm dialog's header
 * glyph — the assistant avatar on the way up, a warning triangle on the way
 * down. One owner for the geometry so the two variants cannot drift; only the
 * fill differs. Decorative: the title beside it carries the meaning.
 */
export function DialogHeaderTile({
  className,
  "data-testid": testId,
  children,
}: DialogHeaderTileProps) {
  return (
    <div
      aria-hidden
      data-testid={testId}
      className={cn(
        "flex size-[52px] shrink-0 items-center justify-center rounded-xl",
        className,
      )}
    >
      {children}
    </div>
  );
}
