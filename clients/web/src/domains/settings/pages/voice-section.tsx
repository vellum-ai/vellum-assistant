/**
 * One titled group of cards on Settings > Voice. Shared by the page and its
 * loading placeholder so both render the same scaffolding.
 */

import type { ReactNode } from "react";

export function VoiceSection({
  heading,
  description,
  children,
}: {
  heading: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-label-medium-default uppercase tracking-wide text-[var(--content-tertiary)]">
          {heading}
        </h2>
        {description && (
          <p className="text-body-small-default text-[var(--content-quiet)]">
            {description}
          </p>
        )}
      </div>
      {children}
    </section>
  );
}
