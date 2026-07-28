import { Loader2 } from "lucide-react";

import type { PlanSpec } from "@/domains/settings/billing/plan-spec";
import { SpecChip } from "@/domains/settings/billing/spec-chip";
import { cn } from "@/utils/misc";
import { Button } from "@vellumai/design-library/components/button";
import { Typography } from "@vellumai/design-library/components/typography";

export interface PlanPromoCardProps {
  title: string;
  /** Spec chips under the title; omitted on the customize variant. */
  specs?: PlanSpec[];
  ctaLabel: string;
  ctaTestId?: string;
  pending?: boolean;
  disabled?: boolean;
  onCtaClick: () => void;
  /** Extra root classes (e.g. the lg:flex-[2] width share); applied last. */
  className?: string;
}

/**
 * The dark "promo" card in the billing "Plan" section: a centered title, an
 * optional row of spec chips, and a single CTA. Purely presentational: the
 * parent owns the copy, the specs, the pending/disabled state, and the CTA
 * behavior. The forced `data-theme="dark"` scope resolves the semantic tokens
 * to the mock's dark palette (surface ~#17191C, chips on `--surface-overlay`
 * ~#1C2024). The card is narrow, so the chip row wraps.
 */
export function PlanPromoCard({
  title,
  specs,
  ctaLabel,
  ctaTestId,
  pending = false,
  disabled = false,
  onCtaClick,
  className,
}: PlanPromoCardProps) {
  return (
    <div
      data-theme="dark"
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center justify-center gap-5 rounded-xl bg-[var(--surface-base)] py-5 pl-3 pr-4",
        className,
      )}
    >
      <div className="flex flex-col items-center gap-2 text-center">
        <Typography
          as="span"
          variant="body-large-default"
          className="text-[var(--content-default)]"
        >
          {title}
        </Typography>
        {specs?.length ? (
          <div className="flex flex-wrap items-center justify-center gap-2">
            {specs.map((spec) => (
              <SpecChip key={spec.label} icon={spec.icon} label={spec.label} />
            ))}
          </div>
        ) : null}
      </div>
      <Button
        variant="primary"
        className="h-8 shrink-0"
        onClick={onCtaClick}
        disabled={disabled || pending}
        leftIcon={
          pending ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined
        }
        data-testid={ctaTestId}
      >
        {ctaLabel}
      </Button>
    </div>
  );
}
