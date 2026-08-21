import type { ReactNode } from "react";

import { Typography } from "@vellumai/design-library/components/typography";

import type { PlanSpec } from "@/domains/settings/billing/plan-spec";
import { PlanTierAvatar } from "@/domains/settings/billing/plan-tier-meta";
import { SpecChip } from "@/domains/settings/billing/spec-chip";
import { cn } from "@/utils/misc";

export interface PlanTileProps {
  /**
   * Nested theme scope for the tile. The next-plan tile inverts the app theme
   * (a dark tile on a light app, a light tile on a dark app); omit to inherit
   * the app theme, as the current-plan tile does.
   */
  theme?: "light" | "dark";
  /** Tier key for the creature avatar ("free" or a package key). */
  tierKey: string;
  name: string;
  nameTestId?: string;
  /** The "Current" / "Next Plan" tag rendered above the avatar row. */
  tag: ReactNode;
  /** Vertical spec-chip stack; omitted entirely when null or empty. */
  specs?: PlanSpec[] | null;
  /**
   * Lay the short chips out as a wrapping row instead of a vertical stack. Any
   * spec flagged `ownRow` still gets a full-width row of its own below that
   * group, which is where the long usage and extras labels go.
   */
  specsWrap?: boolean;
  /** Bottom slot (price row or CTA), pinned to the tile's bottom edge. */
  footer?: ReactNode;
  testId?: string;
  className?: string;
}

/**
 * One tile in the billing "Plan" section's side-by-side comparison: tag,
 * creature avatar and plan name, spec chips, and a bottom slot. Renders both
 * the current-plan tile (inherited theme, price footer) and the next-plan
 * tile (inverted theme scope, upgrade CTA footer).
 */
export function PlanTile({
  theme,
  tierKey,
  name,
  nameTestId,
  tag,
  specs,
  specsWrap = false,
  footer,
  testId,
  className,
}: PlanTileProps) {
  const rowSpecs = specs?.filter((spec) => !spec.ownRow) ?? [];
  const ownRowSpecs = specs?.filter((spec) => spec.ownRow) ?? [];
  return (
    <div
      data-theme={theme}
      data-testid={testId}
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-8 rounded-xl bg-[var(--surface-base)] px-4 py-3",
        className,
      )}
    >
      <div className="flex flex-col items-start gap-6">
        {tag}
        <div className="flex items-center gap-4">
          <PlanTierAvatar tier={tierKey} size={48} />
          <Typography
            as="span"
            variant="title-large"
            className="text-[var(--content-emphasised)]"
            data-testid={nameTestId}
          >
            {name}
          </Typography>
        </div>
      </div>
      {specs?.length ? (
        specsWrap ? (
          <div className="flex flex-col items-start gap-1">
            {rowSpecs.length ? (
              <div className="flex flex-row flex-wrap items-start gap-1">
                {rowSpecs.map((spec) => (
                  <SpecChip
                    key={spec.label}
                    icon={spec.icon}
                    label={spec.label}
                    multiline={spec.multiline}
                  />
                ))}
              </div>
            ) : null}
            {ownRowSpecs.map((spec) => (
              // An own-row chip has the whole tile width, so let a long label
              // wrap inside the pill rather than pushing past the tile.
              <SpecChip
                key={spec.label}
                icon={spec.icon}
                label={spec.label}
                multiline
              />
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-start gap-2">
            {specs.map((spec) => (
              <SpecChip
                key={spec.label}
                icon={spec.icon}
                label={spec.label}
                multiline={spec.multiline}
              />
            ))}
          </div>
        )
      ) : null}
      {footer ? <div className="mt-auto w-full">{footer}</div> : null}
    </div>
  );
}
