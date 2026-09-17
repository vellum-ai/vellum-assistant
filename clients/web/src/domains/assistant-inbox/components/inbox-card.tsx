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
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Where the footer's actions sit. A single action reads best centred. */
  footerAlign?: "end" | "center";
  className?: string;
}

/**
 * The centred card the inbox draws before there is any mail to show: the
 * serif title with its supporting line, a body, and an action row.
 */
export function InboxCard({
  title,
  subtitle,
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
      {/* Even top and bottom: the title sits as far from the card's top as
          the action does from its bottom. */}
      <div className="relative flex flex-col gap-6 px-8 py-8">
        <header className="flex flex-col items-center gap-2 text-center">
          <h2 className="text-[var(--content-emphasised)]" style={TITLE_STYLE}>
            {title}
          </h2>
          {subtitle ? (
            /* Capped short of the edges so a longer line wraps well before
               the card's. */
            <p className="max-w-[380px] text-[14px] text-[var(--content-secondary)]">
              {subtitle}
            </p>
          ) : null}
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
