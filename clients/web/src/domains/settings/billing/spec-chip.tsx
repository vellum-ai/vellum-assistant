import type { LucideIcon } from "lucide-react";

import { Typography } from "@vellumai/design-library/components/typography";

export interface SpecChipProps {
  icon: LucideIcon;
  label: string;
}

/** A single plan-spec pill: an icon and a compact label (e.g. "$25 credits"). */
export function SpecChip({ icon: Icon, label }: SpecChipProps) {
  return (
    <div className="flex h-8 items-center gap-1.5 rounded-lg bg-[var(--surface-overlay)] px-2 py-1.5">
      <Icon
        className="h-3.5 w-3.5 shrink-0 text-[var(--content-default)]"
        aria-hidden
      />
      <Typography
        as="span"
        variant="body-medium-default"
        className="whitespace-nowrap text-[var(--content-default)]"
      >
        {label}
      </Typography>
    </div>
  );
}
