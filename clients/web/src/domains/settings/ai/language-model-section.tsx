import type { ReactNode } from "react";

import { Typography } from "@vellumai/design-library/components/typography";

interface LanguageModelSectionProps {
  title: string;
  /**
   * Item count rendered after the title as "Title • n" (the collapsed
   * Overrides section header). Omitted when the section lists its items
   * inline and the count would be redundant.
   */
  count?: number;
  /** Right-aligned header action (e.g. "+ Create Profile", "Manage"). */
  action?: ReactNode;
  /**
   * Section rows. `ListRow` siblings self-divide; this wrapper adds the
   * hairline between the header and the first row. Omit for header-only
   * sections (the collapsed Overrides row).
   */
  children?: ReactNode;
}

/**
 * Inner section card of the Language Model settings card (Figma 7412:133358):
 * a lifted sub-panel with a header row (title + action) and an optional
 * divided list of rows. Shared by the Profiles, Providers, and Overrides
 * sections so the three read as one system.
 */
export function LanguageModelSection({
  title,
  count,
  action,
  children,
}: LanguageModelSectionProps) {
  return (
    <section className="rounded-xl border border-[var(--border-hover)] bg-[var(--surface-overlay)] px-3 py-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <Typography
            variant="body-large-default"
            as="h3"
            className="text-[var(--content-secondary)]"
          >
            {title}
          </Typography>
          {count != null ? (
            <Typography
              variant="body-large-default"
              as="span"
              aria-label={`${count} ${title.toLowerCase()}`}
              className="text-[var(--content-disabled)]"
            >
              {"·"} {count}
            </Typography>
          ) : null}
        </div>
        {action}
      </div>
      {children != null ? (
        <div className="mt-4 border-t border-[var(--border-base)]">
          {children}
        </div>
      ) : null}
    </section>
  );
}
