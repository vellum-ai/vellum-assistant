import { useState } from "react";

import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";
import { LazyAddCreditsModal } from "@/domains/chat/components/lazy-add-credits-modal";
import { useLowBalanceBannerStore } from "@/stores/low-balance-banner-store";

/**
 * Proactive composer-flush banner shown while the org's credit balance sits in
 * the server-computed warn band. Visibility is decided by
 * `resolveComposerBillingBanner`; this component is purely presentational and
 * owns its own Add Credits modal instance. Copy is deliberately phrased around
 * the flag rather than the numbers: `low_balance_warning` compares the raw
 * balance while display fields are rounded, so near band edges the displayed
 * balance can equal or exceed the displayed threshold while the flag is true.
 */
export function LowBalanceBanner() {
  const dismiss = useLowBalanceBannerStore.use.dismiss();
  const [showAddCredits, setShowAddCredits] = useState(false);
  return (
    <>
      <BillingErrorBanner
        ariaLabel="Your credits are running low. Add credits to avoid an interruption."
        title="Your credits are running low"
        subtitle="Add credits to avoid an interruption."
        ctaLabel="Add credits"
        onAction={() => setShowAddCredits(true)}
        onDismiss={dismiss}
      />
      <LazyAddCreditsModal
        open={showAddCredits}
        onOpenChange={setShowAddCredits}
      />
    </>
  );
}
