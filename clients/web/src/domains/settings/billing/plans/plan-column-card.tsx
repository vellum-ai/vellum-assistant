import { CircleCheck } from "lucide-react";

import { PlanTierAvatar } from "@/domains/settings/billing/plan-tier-meta";
import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";

export interface PlanColumnCardProps {
  /** Tier key ("free" or a `ProPackage.key`) — selects the creature avatar. */
  tierKey: string;
  name: string;
  tagline: string;
  /** Formatted price, e.g. "$50/month". */
  priceLabel: string;
  priceCaption: string;
  /** CTA label for a selectable tier; ignored when `isCurrent`. */
  ctaLabel: string;
  features: readonly string[];
  mostPopular?: boolean;
  /**
   * The featured tier renders as the white/light card; the rest stay dark. The
   * value drives a nested `data-theme` scope so the design tokens inside the
   * card resolve to the right palette.
   */
  tone?: "dark" | "light";
  isCurrent: boolean;
  /** A checkout is in flight — disable every CTA until it resolves. */
  pending: boolean;
  onCta: () => void;
}

/**
 * One pricing column in the View Plans takeover. Layout-only: the parent owns
 * the catalog data, the current-plan decision, and the CTA behavior.
 */
export function PlanColumnCard({
  tierKey,
  name,
  tagline,
  priceLabel,
  priceCaption,
  ctaLabel,
  features,
  mostPopular = false,
  tone = "dark",
  isCurrent,
  pending,
  onCta,
}: PlanColumnCardProps) {
  return (
    <div
      data-theme={tone}
      className="flex w-full flex-col gap-4 rounded-2xl bg-[var(--surface-lift)] p-4"
    >
      <PlanTierAvatar tier={tierKey} size={50} />

      <div className="flex h-8 items-center gap-2">
        <span className="text-[20px] font-medium text-[var(--content-emphasised)]">
          {name}
        </span>
        {mostPopular ? (
          <Tag className="bg-[var(--feed-digest-weak)] text-[12px] font-semibold uppercase text-[var(--credits-accent)]">
            Most Popular
          </Tag>
        ) : null}
      </div>

      <p className="h-9 overflow-hidden text-[14px] font-medium leading-[18px] text-[var(--content-tertiary)]">
        {tagline}
      </p>

      <div className="h-px w-full bg-[var(--border-hover)]" />

      <div className="flex flex-col gap-1">
        <span className="text-[24px] font-medium text-[var(--content-default)]">
          {priceLabel}
        </span>
        <span className="text-[11px] font-medium text-[var(--content-tertiary)]">
          {priceCaption}
        </span>
      </div>

      <Button
        variant="primary"
        fullWidth
        className="rounded-lg"
        disabled={isCurrent || pending}
        onClick={onCta}
      >
        {isCurrent ? "Current Plan" : ctaLabel}
      </Button>

      <div className="h-px w-full bg-[var(--border-hover)]" />

      <div className="flex flex-col gap-2">
        <span className="text-[12px] font-medium text-[var(--content-tertiary)]">
          Includes:
        </span>
        <ul className="flex flex-col gap-2">
          {features.map((feature) => (
            <li key={feature} className="flex items-start gap-2">
              <CircleCheck
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-secondary)]"
                aria-hidden
              />
              <span className="text-[14px] font-medium text-[var(--content-secondary)]">
                {feature}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
