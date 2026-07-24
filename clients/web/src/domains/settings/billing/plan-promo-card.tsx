import { Loader2 } from "lucide-react";

import { cn } from "@/utils/misc";
import { Button } from "@vellumai/design-library/components/button";
import { Typography } from "@vellumai/design-library/components/typography";

export interface PlanPromoCardProps {
  title: string;
  /** One-line supporting copy under the title; omitted on the customize variant. */
  blurb?: string;
  ctaLabel: string;
  ctaTestId?: string;
  pending?: boolean;
  disabled?: boolean;
  onCtaClick: () => void;
  /** Extra root classes (e.g. the lg:flex-[2] width share); applied last. */
  className?: string;
}

/**
 * The dark "promo" card in the billing "Plan" section — a centered title,
 * optional one-line blurb, and a single CTA. Purely presentational: the parent
 * owns the copy, the pending/disabled state, and the CTA behavior. The forced
 * `data-theme="dark"` scope resolves the semantic tokens to the mock's dark
 * palette (surface ~#17191C, `--content-secondary` blurb ~#A9B2BB).
 */
export function PlanPromoCard({
  title,
  blurb,
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
        {blurb ? (
          <Typography
            as="span"
            variant="body-small-default"
            className="text-[var(--content-secondary)]"
          >
            {blurb}
          </Typography>
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
