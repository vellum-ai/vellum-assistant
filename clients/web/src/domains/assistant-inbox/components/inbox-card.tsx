import type { CSSProperties, ReactNode } from "react";

import { cn } from "@vellumai/design-library";

/** Instrument Serif, as the onboarding cards set their titles. */
const TITLE_STYLE: CSSProperties = {
  fontFamily: "var(--font-serif)",
  fontSize: "32px",
  fontWeight: 400,
  lineHeight: 1.2,
  letterSpacing: "0.64px",
};

export interface InboxCardProps {
  title: string;
  subtitle: string;
  /** The decoration layer, positioned against this card's edges. */
  decoration?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/**
 * The centred card the inbox draws before there is any mail to show: the
 * serif title with its supporting line, a body, and a trailing action row.
 * Overflow is hidden so the creatures the decoration layer hangs off the
 * edges are clipped the way the onboarding cards clip them.
 */
export function InboxCard({
  title,
  subtitle,
  decoration,
  children,
  footer,
  className,
}: InboxCardProps) {
  return (
    <div
      className={cn(
        "relative w-full max-w-[560px] overflow-hidden rounded-2xl border border-[var(--border-subtle)] bg-[var(--surface-lift)] shadow-[0_8px_32px_rgba(0,0,0,0.08)]",
        className,
      )}
    >
      {decoration}
      <div className="relative flex flex-col gap-6 px-8 pb-6 pt-12">
        <header className="flex flex-col items-center gap-2 text-center">
          <h2 className="text-[var(--content-emphasised)]" style={TITLE_STYLE}>
            {title}
          </h2>
          {/* Capped short of the edges so a longer line wraps before it
              runs under the creature looking in from the right. */}
          <p className="max-w-[380px] text-[14px] text-[var(--content-secondary)]">
            {subtitle}
          </p>
        </header>
        {children}
        {footer ? (
          <div className="flex items-center justify-end gap-2 pt-1">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
