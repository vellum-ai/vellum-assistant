import type { ReactNode } from "react";

import { Typography } from "@vellumai/design-library/components/typography";

export interface BillingSectionHeaderProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}

/**
 * Shared header for the billing settings sections (Payment Methods, Credits,
 * Invoices): title + optional subtitle on the left, action buttons on the
 * right, stacking vertically on narrow viewports.
 */
export function BillingSectionHeader({
  title,
  subtitle,
  actions,
}: BillingSectionHeaderProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <Typography
          as="h2"
          variant="title-medium"
          className="text-[var(--content-emphasised)]"
        >
          {title}
        </Typography>
        {subtitle != null && (
          <Typography
            as="p"
            variant="body-medium-default"
            className="mt-2 text-[var(--content-tertiary)]"
          >
            {subtitle}
          </Typography>
        )}
      </div>
      {actions != null && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
