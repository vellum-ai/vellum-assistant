import type { ReactNode } from "react";
import { useTranslation } from "@/i18n";

import { X } from "lucide-react";

import { Button } from "@vellumai/design-library";

interface BillingErrorBannerAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

interface BillingErrorBannerProps {
  ariaLabel: string;
  icon?: ReactNode;
  title: string;
  subtitle: string;
  action?: BillingErrorBannerAction;
  /**
   * Lower-weight action rendered before the primary one. Use it for the escape
   * hatch that relaxes whatever the banner is enforcing: the filled button
   * should stay on the route that respects the user's own setting.
   */
  secondaryAction?: BillingErrorBannerAction;
  /** When provided, renders a small dismiss (X) button after the CTA. */
  onDismiss?: () => void;
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
  action,
  secondaryAction,
  onDismiss,
  detached = false,
}: BillingErrorBannerProps) {
  const { t } = useTranslation("chat");
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

        {action || secondaryAction || onDismiss ? (
          <div className="flex items-center gap-1 shrink-0">
            {secondaryAction ? (
              <Button
                variant="ghost"
                size="regular"
                onClick={secondaryAction.onClick}
                disabled={secondaryAction.disabled}
                aria-label={secondaryAction.label}
              >
                {secondaryAction.label}
              </Button>
            ) : null}
            {action ? (
              <Button
                variant="primary"
                size="regular"
                onClick={action.onClick}
                disabled={action.disabled}
                aria-label={action.label}
              >
                {action.label}
              </Button>
            ) : null}
            {onDismiss ? (
              <Button
                variant="ghost"
                size="compact"
                iconOnly={<X />}
                tooltip={t("billingErrorBanner.dismiss")}
                aria-label={t("billingErrorBanner.dismiss")}
                onClick={onDismiss}
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
