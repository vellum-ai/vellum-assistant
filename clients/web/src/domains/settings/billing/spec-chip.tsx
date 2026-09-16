import type { LucideIcon } from "lucide-react";

import { Typography } from "@vellumai/design-library/components/typography";

export interface SpecChipProps {
  icon: LucideIcon;
  label: string;
}

/**
 * A single plan-spec pill: an icon and a compact label (e.g. "$25 credits").
 *
 * Sized to its content and never shrunk, so a row of chips packs as many as
 * fit and wraps the rest onto the next line instead of squeezing a label
 * mid-pill. `max-w-full` is the one exception: a chip wider than the row on
 * its own wraps inside the pill rather than overflowing the tile.
 */
export function SpecChip({ icon: Icon, label }: SpecChipProps) {
  return (
    <div className="flex min-h-8 max-w-full shrink-0 items-center gap-1.5 rounded-md bg-[var(--surface-lift)] px-2 py-1.5">
      <Icon
        className="size-[18px] shrink-0 text-[var(--content-default)]"
        aria-hidden
      />
      <Typography
        as="span"
        variant="body-medium-default"
        className="whitespace-normal text-[var(--content-default)]"
      >
        {label}
      </Typography>
    </div>
  );
}
