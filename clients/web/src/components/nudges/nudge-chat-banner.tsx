import { X } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@vellumai/design-library";

/**
 * Shared in-chat floating banner used by the iOS, macOS, and GitHub
 * nudges. Each nudge supplies its own icon, copy, and primary CTA; the
 * dismiss interaction is identical across nudges and lives here.
 *
 * Width is constrained to `--chat-max-width` so the banner aligns with
 * the composer below it. Surface tokens follow the design-system
 * conventions (base surface, subtle shadow, no border).
 */
export interface NudgeChatBannerProps {
  /** Decorative leading icon — rendered inside a 32px rounded square. */
  icon: ReactNode;
  /** Single-line title (rendered with `text-body-medium-default`). */
  title: string;
  /** Single-line subtitle — may be a ReactNode for responsive content. */
  subtitle: ReactNode;
  /** CTA button label — may be a ReactNode for responsive content. */
  ctaLabel: ReactNode;
  /** Optional CTA button leading icon. */
  ctaLeftIcon?: ReactNode;
  /** Accessibility label for the CTA button. */
  ctaAriaLabel: string;
  /** Accessibility label for the whole banner (announced as a `status`). */
  ariaLabel: string;
  /** Fired when the user clicks the CTA. */
  onAction: () => void;
  /** Fired when the user dismisses the banner. */
  onDismiss: () => void;
}

export function NudgeChatBanner({
  icon,
  title,
  subtitle,
  ctaLabel,
  ctaLeftIcon,
  ctaAriaLabel,
  ariaLabel,
  onAction,
  onDismiss,
}: NudgeChatBannerProps) {
  return (
    <div
      className="mx-auto flex overflow-hidden rounded-[10px]"
      style={{
        background: "color-mix(in srgb, var(--surface-base) 92%, white)",
        animation: "fadeInUp 0.25s ease-out both",
        maxWidth: "var(--chat-max-width)",
        width: "100%",
        boxShadow: "0 5px 8px 6px rgba(0,0,0,0.03), 0 7px 16px 6px rgba(0,0,0,0.03)",
      }}
      role="status"
      aria-label={ariaLabel}
    >
      <div className="flex flex-1 items-center gap-2 px-[14px] py-3 md:gap-3">
        <span
          className="flex size-8 shrink-0 items-center justify-center rounded-[6px]"
          style={{ background: "var(--surface-lift)" }}
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
            className="text-label-medium-default md:text-label-small-default mt-0.5"
            style={{ color: "var(--content-tertiary)" }}
          >
            {subtitle}
          </p>
        </div>

        <Button
          variant="primary"
          size="regular"
          leftIcon={ctaLeftIcon}
          onClick={onAction}
          aria-label={ctaAriaLabel}
        >
          {ctaLabel}
        </Button>

        <Button
          className="ml-1 md:ml-0"
          variant="ghost"
          size="regular"
          iconOnly={<X />}
          onClick={onDismiss}
          aria-label="Dismiss"
        />
      </div>
    </div>
  );
}
