
import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";
import type { CreditPaywallCtaMode } from "@/domains/chat/utils/credit-paywall-cta";

const COPY: Record<
  CreditPaywallCtaMode,
  { title: string; subtitle: string; ctaLabel: string }
> = {
  upgrade: {
    title: "You’ve used all your Free credits",
    subtitle: "Upgrade to a higher plan to continue.",
    ctaLabel: "View plans",
  },
  "add-credits-free": {
    title: "You’ve used all your credits",
    subtitle: "Add credits to continue without changing your plan.",
    ctaLabel: "Add credits",
  },
  "add-credits-paid": {
    title: "You’ve used all your credits",
    subtitle: "Add more credits to keep going.",
    ctaLabel: "Add credits",
  },
};

interface CreditsExhaustedBannerProps {
  mode: CreditPaywallCtaMode;
  onAddCredits: () => void;
  onUpgrade: () => void;
}

export function CreditsExhaustedBanner({
  mode,
  onAddCredits,
  onUpgrade,
}: CreditsExhaustedBannerProps) {
  const copy = COPY[mode];
  return (
    <BillingErrorBanner
      ariaLabel={`${copy.title}. ${copy.subtitle}`}
      title={`💰  ${copy.title}`}
      subtitle={copy.subtitle}
      ctaLabel={copy.ctaLabel}
      onAction={mode === "upgrade" ? onUpgrade : onAddCredits}
      detached={true}
    />
  );
}
