import type { ReactNode } from "react";

import { Card, Typography, cn } from "@vellumai/design-library";

/**
 * A details card sized for **inset** contexts: inside a sidepanel body, a
 * modal, or anywhere already nested in its own surface.
 *
 * Use this instead of `DetailCard`, which is the page-level card and is scaled
 * for larger surfaces. Two differences carry that distinction:
 *
 * - **16px title** (`title-small`) rather than `DetailCard`'s 20px
 *   `title-medium`, which competes with a sidepanel header's own title.
 * - **12px corners** (`rounded-lg` → `--radius-lg`) rather than the 16px
 *   `rounded-xl` the `Card` primitive defaults to, so the inner card reads as
 *   nested inside the panel's own rounding rather than tying with it.
 */
export interface InsetDetailCardProps {
  id?: string;
  title?: string;
  /** Secondary line under the title (e.g. what the section covers). */
  subtitle?: ReactNode;
  /** Right-aligned slot on the header row (e.g. a "Load more" button). */
  accessory?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function InsetDetailCard({
  id,
  title,
  subtitle,
  accessory,
  children,
  className,
}: InsetDetailCardProps) {
  const hasHeader = Boolean(title || subtitle || accessory);

  return (
    // `rounded-lg` (12px) lands after the Card's own classes, so tailwind-merge
    // drops the primitive's `rounded-xl` (16px).
    <Card asChild className={cn("rounded-lg", className)}>
      <section id={id}>
        {hasHeader && (
          <div className="flex flex-row items-start justify-between gap-4">
            <div className="flex min-w-0 flex-col gap-1">
              {title && (
                <Typography
                  variant="title-small"
                  as="h2"
                  className="text-[var(--content-emphasised)]"
                >
                  {title}
                </Typography>
              )}
              {subtitle && (
                <Typography
                  variant="body-small-default"
                  as="p"
                  className="text-[var(--content-tertiary)]"
                >
                  {subtitle}
                </Typography>
              )}
            </div>
            {accessory && <div className="shrink-0">{accessory}</div>}
          </div>
        )}
        {children != null && (
          <div className={hasHeader ? "mt-3" : ""}>{children}</div>
        )}
      </section>
    </Card>
  );
}
