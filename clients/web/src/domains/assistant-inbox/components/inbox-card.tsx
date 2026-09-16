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
  /** Sits above the title, centred: an avatar, a glyph. */
  leading?: ReactNode;
  /** The decoration layer, positioned against this card's edges. */
  decoration?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  /** Where the footer's actions sit. A single action reads best centred. */
  footerAlign?: "end" | "center";
  className?: string;
}

/**
 * The centred card the inbox draws before there is any mail to show: the
 * serif title with its supporting line, a body, and a trailing action row.
 * Overflow is hidden so anything the decoration layer hangs off the edges
 * is clipped the way the onboarding cards clip it.
 */
export function InboxCard({
  title,
  subtitle,
  leading,
  decoration,
  children,
  footer,
  footerAlign = "end",
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
      <div
        className={cn(
          "relative flex flex-col gap-6 px-8 pb-6",
          leading ? "pt-8" : "pt-12",
        )}
      >
        <header className="flex flex-col items-center gap-2 text-center">
          {leading ? <div className="mb-2">{leading}</div> : null}
          <h2 className="text-[var(--content-emphasised)]" style={TITLE_STYLE}>
            {title}
          </h2>
          {/* Capped short of the edges so a longer line wraps before it
              runs under anything looking in from the right. */}
          <p className="max-w-[380px] text-[14px] text-[var(--content-secondary)]">
            {subtitle}
          </p>
        </header>
        {children}
        {footer ? (
          <div
            className={cn(
              "flex items-center gap-2 pt-1",
              footerAlign === "center" ? "justify-center" : "justify-end",
            )}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
