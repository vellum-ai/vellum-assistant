
import type { ReactNode } from "react";

import { Button } from "@vellumai/design-library";

interface BillingErrorBannerProps {
  ariaLabel: string;
  icon?: ReactNode;
  title: string;
  subtitle: string;
  ctaLabel: string;
  onAction: () => void;
  /**
   * Render as a standalone, centered card ~24px narrower than the composer with
   * full rounding, instead of a full-width banner flush-mounted above the
   * composer (which flattens its bottom corners into the composer top).
   */
  detached?: boolean;
}

export function BillingErrorBanner({
  ariaLabel,
  icon,
  title,
  subtitle,
  ctaLabel,
  onAction,
  detached = false,
}: BillingErrorBannerProps) {
  return (
    <div
      className="flex overflow-hidden"
      style={{
        background: "var(--surface-active)",
        animation: "fadeInUp 0.25s ease-out both",
        width: "100%",
        ...(detached
          ? {
              maxWidth: "calc(100% - 24px)",
              marginInline: "auto",
              borderRadius: "10px",
            }
          : { borderRadius: "10px 10px 0 0" }),
      }}
      role="status"
      aria-label={ariaLabel}
    >
      <div className="flex flex-1 items-center gap-3 px-4 py-3">
        {icon ? (
          <span
            className="flex size-8 shrink-0 items-center justify-center"
            aria-hidden="true"
          >
            {icon}
          </span>
        ) : null}

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

        <div className="flex items-center shrink-0">
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
    </div>
  );
}
