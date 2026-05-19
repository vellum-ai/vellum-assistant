
import type { ReactNode } from "react";

import { Card } from "@vellum/design-library/components/card";
import { cn } from "@vellum/design-library/utils/cn";

/**
 * Thin composition over `Card` for the Settings tabs. Adds an optional
 * title/subtitle/accessory header block, a `danger` variant, and a
 * `showBorder={false}` escape hatch that drops the card chrome entirely.
 */
export interface SettingsCardProps {
  id?: string;
  title?: string;
  subtitle?: string;
  accessory?: ReactNode;
  /**
   * Set when the accessory is a small inline element (e.g. an icon button
   * or a single Tag) that should sit beside the title at every viewport
   * rather than wrap onto its own row on mobile. The default behavior
   * stacks accessory below the title block on narrow viewports so wide
   * accessories (e.g. `SegmentControl`) don't squeeze the title.
   */
  compactAccessory?: boolean;
  children?: ReactNode;
  showBorder?: boolean;
  variant?: "default" | "danger";
  className?: string;
}

export function SettingsCard({
  id,
  title,
  subtitle,
  accessory,
  compactAccessory = false,
  children,
  showBorder = true,
  variant = "default",
  className,
}: SettingsCardProps) {
  const hasHeader = Boolean(title || subtitle || accessory);
  const body = (
    <>
      {hasHeader && (
        // Default behavior: stack title + accessory vertically on mobile
        // so a wide accessory (e.g. SegmentControl) doesn't squeeze the
        // title into a narrow column; switch to side-by-side at `md+`.
        // `compactAccessory` opts into the always-inline layout for small
        // accessories like a single icon button — those look orphaned on
        // their own line below the title.
        <div
          className={
            compactAccessory
              ? "flex flex-row items-start justify-between gap-4"
              : "flex flex-col items-start gap-3 md:flex-row md:items-start md:justify-between md:gap-4"
          }
        >
          <div className="flex min-w-0 flex-col gap-2">
            {title && (
              <h2 className="text-title-medium text-[var(--content-emphasised)]">
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="text-body-medium-default text-[var(--content-tertiary)]">
                {subtitle}
              </p>
            )}
          </div>
          {accessory && <div className="shrink-0">{accessory}</div>}
        </div>
      )}
      {children != null && (
        <div className={hasHeader ? "mt-4" : ""}>{children}</div>
      )}
    </>
  );

  if (!showBorder) {
    return (
      <section id={id} className={cn("space-y-4", className)}>
        {body}
      </section>
    );
  }

  return (
    <Card
      asChild
      className={cn(
        variant === "danger" &&
          "border-[var(--system-negative-weak)] bg-[var(--surface-lift)]",
        className,
      )}
    >
      <section id={id}>{body}</section>
    </Card>
  );
}
