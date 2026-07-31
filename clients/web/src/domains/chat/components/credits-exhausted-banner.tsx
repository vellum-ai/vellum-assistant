import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";
import type { CreditPaywallCtaMode } from "@/domains/chat/utils/credit-paywall-cta";
import { ANDROID_BILLING_MESSAGE } from "@/lib/billing/android-consumption-only";
import { useIsNativeAndroid } from "@/runtime/platform-detection";

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
  const isNativeAndroid = useIsNativeAndroid();
  const action = isNativeAndroid
    ? undefined
    : {
        label: copy.ctaLabel,
        onClick: mode === "upgrade" ? onUpgrade : onAddCredits,
      };
  return (
    <BillingErrorBanner
      ariaLabel={`${copy.title}. ${
        isNativeAndroid ? ANDROID_BILLING_MESSAGE : copy.subtitle
      }`}
      title={`💰  ${copy.title}`}
      subtitle={isNativeAndroid ? ANDROID_BILLING_MESSAGE : copy.subtitle}
      action={action}
      detached={true}
    />
  );
}
