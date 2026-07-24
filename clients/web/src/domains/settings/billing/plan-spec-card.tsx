import type { ReactNode } from "react";

import { PlanTierAvatar } from "@/domains/settings/billing/plan-tier-meta";
import type { PlanSpec } from "@/domains/settings/billing/plan-spec";
import { SpecChip } from "@/domains/settings/billing/spec-chip";
import { cn } from "@/utils/misc";
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
  /** Centers the card content on both axes (the minimal free current card). */
  centered?: boolean;
  /** Extra root classes (e.g. a responsive width override); applied last. */
  className?: string;
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
  centered = false,
  className,
}: PlanSpecCardProps) {
  const hasSpecs = specs != null && specs.length > 0;
  return (
    <div
      data-theme={tone}
      className={cn(
        "flex min-w-0 flex-1 flex-col gap-4 rounded-xl bg-[var(--surface-base)] py-3 pl-3 pr-4",
        centered && "items-center justify-center",
        className,
      )}
    >
      <div
        className={cn(
          "flex items-center gap-3",
          centered ? "justify-center" : "justify-between",
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          <PlanTierAvatar tier={tierKey} />
          <div className="flex min-w-0 flex-col gap-1.5">
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
          {/* mt-auto anchors the divider + chips to the bottom of the card, so
              the chip rows align across the two cards even when one card is
              taller (e.g. a wrapped tagline) and `items-stretch` stretches the
              other — matching the mock, where chips sit near the card bottom. */}
          <div className="mt-auto h-px w-full bg-[var(--border-base)]" />
          <div className="flex flex-wrap items-center gap-2">
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
