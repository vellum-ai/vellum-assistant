import type { LucideIcon } from "lucide-react";

import { Typography } from "@vellumai/design-library/components/typography";

import { cn } from "@/utils/misc";

export interface SpecChipProps {
  icon: LucideIcon;
  label: string;
  /** Render as a wrap-capable pill instead of forcing a single line. */
  multiline?: boolean;
}

/** A single plan-spec pill: an icon and a compact label (e.g. "$25 credits"). */
export function SpecChip({
  icon: Icon,
  label,
  multiline = false,
}: SpecChipProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-lg bg-[var(--surface-overlay)] px-2 py-1.5",
        multiline ? "min-h-8 min-w-0" : "h-8",
      )}
    >
      <Icon
        className="h-3.5 w-3.5 shrink-0 text-[var(--content-default)]"
        aria-hidden
      />
      <Typography
        as="span"
        variant="body-medium-default"
        className={cn(
          "text-[var(--content-default)]",
          multiline ? "whitespace-normal" : "whitespace-nowrap",
        )}
      >
        {label}
      </Typography>
    </div>
  );
}
