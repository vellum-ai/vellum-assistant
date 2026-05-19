
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@vellum/design-library/components/button";

/**
 * Shared sidebar footer entry used by the iOS, macOS, and GitHub
 * nudges. Composition mirrors the in-chat banner: each nudge supplies
 * its own copy and CTA icon while the chrome — overlay surface, base
 * border, top-right dismiss affordance — is consistent.
 */
export interface NudgeSidebarEntryProps {
  /** Single-line title (rendered with `text-body-small-default`). */
  title: string;
  /**
   * Body description (rendered with `text-label-small-default`). Wraps
   * across multiple lines if needed.
   */
  description: string;
  /** CTA button label. */
  ctaLabel: string;
  /** Required CTA button leading icon — sidebar CTAs always pair an icon. */
  ctaLeftIcon: ReactNode;
  /** Fired when the user clicks the CTA. */
  onAction: () => void;
  /** Fired when the user dismisses the sidebar entry. */
  onDismiss: () => void;
}

export function NudgeSidebarEntry({
  title,
  description,
  ctaLabel,
  ctaLeftIcon,
  onAction,
  onDismiss,
}: NudgeSidebarEntryProps) {
  return (
    <div
      className="group relative overflow-hidden rounded-lg border"
      style={{
        background: "var(--surface-overlay)",
        borderColor: "var(--border-base)",
        animation: "fadeInUp 0.25s ease-out both",
      }}
    >
      <button
        type="button"
        className="absolute right-1.5 top-1.5 flex size-5 cursor-pointer items-center justify-center rounded-md transition-opacity hover:opacity-70"
        style={{ color: "var(--content-tertiary)" }}
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        <X size={12} aria-hidden />
      </button>

      <div className="flex flex-col gap-2.5 px-3 py-3">
        <div>
          <p
            className="text-body-small-default leading-tight"
            style={{ color: "var(--content-default)" }}
          >
            {title}
          </p>
          <p
            className="text-label-small-default mt-1 leading-relaxed"
            style={{ color: "var(--content-tertiary)" }}
          >
            {description}
          </p>
        </div>

        <Button
          variant="primary"
          size="compact"
          fullWidth
          leftIcon={ctaLeftIcon}
          onClick={onAction}
        >
          {ctaLabel}
        </Button>
      </div>
    </div>
  );
}
