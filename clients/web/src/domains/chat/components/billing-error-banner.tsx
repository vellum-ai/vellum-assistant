
import type { ReactNode } from "react";

import { Button } from "@vellumai/design-library";

interface BillingErrorBannerProps {
  ariaLabel: string;
  icon: ReactNode;
  title: string;
  subtitle: string;
  ctaLabel: string;
  onAction: () => void;
}

export function BillingErrorBanner({
  ariaLabel,
  icon,
  title,
  subtitle,
  ctaLabel,
  onAction,
}: BillingErrorBannerProps) {
  return (
    <div
      className="flex overflow-hidden"
      style={{
        background: "var(--surface-active)",
        borderRadius: "10px 10px 0 0",
        animation: "fadeInUp 0.25s ease-out both",
        width: "100%",
      }}
      role="status"
      aria-label={ariaLabel}
    >
      <div className="flex flex-1 items-center gap-3 px-4 py-3">
        <span
          className="flex size-8 shrink-0 items-center justify-center"
          aria-hidden="true"
        >
          {icon}
        </span>

        <div className="min-w-0 flex-1">
          <p
            className="text-body-medium-default leading-tight"
            style={{ color: "var(--content-default)" }}
          >
            {title}
          </p>
          <p
            className="text-label-small-default mt-0.5"
            style={{ color: "var(--content-tertiary)" }}
          >
            {subtitle}
          </p>
        </div>

        <Button
          variant="primary"
          size="regular"
          onClick={onAction}
          aria-label={ctaLabel}
        >
          {ctaLabel}
        </Button>
      </div>
    </div>
  );
}
