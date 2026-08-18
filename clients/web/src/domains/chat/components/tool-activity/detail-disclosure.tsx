/**
 * Expandable section used by the tool-specific activity renderers to keep long
 * secondary content (a skill's full instruction body, the raw JSON escape
 * hatch) out of the way without hiding it.
 *
 * Wraps the design-library `Collapsible` primitive with the chrome this drawer
 * uses: a chevron that rotates on open, a tertiary uppercase label, and an
 * optional right-aligned hint (e.g. a line count).
 */

import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";

import { Collapsible, Typography } from "@vellumai/design-library";

export function DetailDisclosure({
  label,
  hint,
  defaultOpen = false,
  children,
}: {
  /** Uppercase section label, e.g. "Instructions". */
  label: string;
  /** Optional right-aligned secondary text, e.g. "412 lines". */
  hint?: string;
  /** Whether the section starts expanded. */
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const value = `disclosure-${label}`;
  return (
    <Collapsible.Root
      type="single"
      collapsible
      defaultValue={defaultOpen ? value : undefined}
    >
      <Collapsible.Item value={value}>
        <Collapsible.Trigger className="group gap-1.5 py-1 text-left">
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--content-tertiary)] transition-transform group-data-[state=open]:rotate-90" />
          {/* `leading-4` clears the `line-height: 1` on the label token. */}
          <Typography
            variant="label-small-default"
            as="span"
            className="uppercase leading-4 tracking-wider text-[var(--content-tertiary)]"
          >
            {label}
          </Typography>
          {hint && (
            <Typography
              variant="label-small-default"
              as="span"
              className="ml-auto pl-2 leading-4 text-[var(--content-tertiary)]"
            >
              {hint}
            </Typography>
          )}
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div className="pt-2">{children}</div>
        </Collapsible.Content>
      </Collapsible.Item>
    </Collapsible.Root>
  );
}
