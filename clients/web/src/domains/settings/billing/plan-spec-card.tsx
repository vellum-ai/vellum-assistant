import type { ReactNode } from "react";

import { PlanTierAvatar } from "@/domains/settings/billing/plan-tier-meta";
import type { PlanSpec } from "@/domains/settings/billing/plan-spec";
import { SpecChip } from "@/domains/settings/billing/spec-chip";
import { cn } from "@/utils/misc";
import { Typography } from "@vellumai/design-library/components/typography";

export interface PlanSpecCardProps {
  /** Tier key ("free" or a `ProPackage.key`) — selects the creature avatar. */
  tierKey: string;
  name: string;
  /** Test id applied to the plan-name node (e.g. "plan-card-name"). */
  nameTestId?: string;
  /** Rendered right of the name, e.g. a "Current Plan" tag. */
  tag?: ReactNode;
  /** Absolute spec chips; when null/empty the dividers + chip row are omitted. */
  specs?: PlanSpec[] | null;
  /** Extra root classes (e.g. a responsive width override); applied last. */
  className?: string;
}

/**
 * The current-plan card in the billing "Plan" section. Layout-only: the parent
 * owns the catalog data, the current-plan decision, and any CTA behavior. The
 * forced light `data-theme` scope resolves the semantic tokens to the mock's
 * light (current-plan) palette. Content is centered on both axes: when spec
 * chips are present, the header row sits between two dividers with a centered
 * chip row beneath; otherwise only the centered header row renders.
 */
export function PlanSpecCard({
  tierKey,
  name,
  nameTestId,
  tag,
  specs,
  className,
}: PlanSpecCardProps) {
  const hasSpecs = specs != null && specs.length > 0;
  return (
    <div
      data-theme="light"
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center justify-center gap-4 rounded-xl bg-[var(--surface-base)] py-3 pl-3 pr-4",
        className,
      )}
    >
      {hasSpecs ? (
        <div className="h-px w-full bg-[var(--border-base)]" />
      ) : null}
      <div className="flex items-center gap-3">
        <PlanTierAvatar tier={tierKey} size={48} />
        <div className="flex flex-wrap items-center gap-1.5">
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
      </div>
      {hasSpecs ? (
        <>
          <div className="h-px w-full bg-[var(--border-base)]" />
          <div className="flex flex-wrap items-center justify-center gap-2">
            {specs.map((spec) => (
              <SpecChip
                key={spec.label}
                icon={spec.icon}
                label={spec.label}
                multiline={spec.multiline}
              />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
