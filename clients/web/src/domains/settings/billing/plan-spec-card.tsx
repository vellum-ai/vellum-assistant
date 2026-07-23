import type { ReactNode } from "react";

import { PlanTierAvatar } from "@/domains/settings/billing/plan-tier-meta";
import type { PlanSpec } from "@/domains/settings/billing/plan-spec";
import { SpecChip } from "@/domains/settings/billing/spec-chip";
import { Typography } from "@vellumai/design-library/components/typography";

export interface PlanSpecCardProps {
  /** Forces the card palette: "light" (current) or "dark" (recommended). */
  tone: "light" | "dark";
  /** Tier key ("free" or a `ProPackage.key`) — selects the creature avatar. */
  tierKey: string;
  name: string;
  /** Test id applied to the plan-name node (e.g. "plan-card-name"). */
  nameTestId?: string;
  /** Rendered right of the name, e.g. a "Your Current Plan" / "Recommended" tag. */
  tag?: ReactNode;
  tagline?: string;
  /** Absolute spec chips; when null/empty the divider + chip row are omitted. */
  specs?: PlanSpec[] | null;
  /** Header right-aligned action (e.g. the Upgrade button). */
  action?: ReactNode;
}

/**
 * One plan card in the billing "Plan" section. Layout-only: the parent owns
 * the catalog data, the current-plan decision, and any CTA behavior. The
 * forced `data-theme` scope resolves the semantic tokens to the mock's
 * light (current) / dark (recommended) palettes.
 */
export function PlanSpecCard({
  tone,
  tierKey,
  name,
  nameTestId,
  tag,
  tagline,
  specs,
  action,
}: PlanSpecCardProps) {
  const hasSpecs = specs != null && specs.length > 0;
  return (
    <div
      data-theme={tone}
      className="flex flex-1 flex-col gap-4 rounded-xl bg-[var(--surface-base)] py-3 pl-3 pr-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <PlanTierAvatar tier={tierKey} />
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <Typography
                as="span"
                variant="body-large-default"
                className="text-[var(--content-default)]"
                data-testid={nameTestId}
              >
                {name}
              </Typography>
              {tag}
            </div>
            {tagline ? (
              <Typography
                as="span"
                variant="body-small-default"
                className="text-[var(--content-tertiary)]"
              >
                {tagline}
              </Typography>
            ) : null}
          </div>
        </div>
        {action}
      </div>
      {hasSpecs ? (
        <>
          <div className="h-px w-full bg-[var(--border-base)]" />
          <div className="flex flex-wrap items-center gap-2">
            {specs.map((spec) => (
              <SpecChip key={spec.label} icon={spec.icon} label={spec.label} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
