import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";
import { useAddCreditsModalStore } from "@/stores/add-credits-modal-store";
import { useLowBalanceBannerStore } from "@/stores/low-balance-banner-store";

/**
 * Proactive composer-flush banner shown while the org's credit balance sits in
 * the server-computed warn band. Visibility is decided by
 * `resolveComposerBillingBanner`; this component is purely presentational and
 * its Add Credits CTA opens the shared modal mounted in `ActiveChatView` (via
 * {@link useAddCreditsModalStore}), so the checkout survives the banner
 * unmounting on a balance change. Copy is deliberately phrased around
 * the flag rather than the numbers: `low_balance_warning` compares the raw
 * balance while display fields are rounded, so near band edges the displayed
 * balance can equal or exceed the displayed threshold while the flag is true.
 */
export function LowBalanceBanner() {
  const dismiss = useLowBalanceBannerStore.use.dismiss();
  return (
    <BillingErrorBanner
      ariaLabel="Your credits are running low. Add credits to avoid an interruption."
      title="Your credits are running low"
      subtitle="Add credits to avoid an interruption."
      ctaLabel="Add credits"
      onAction={() => useAddCreditsModalStore.getState().setOpen(true)}
      onDismiss={dismiss}
    />
  );
}
