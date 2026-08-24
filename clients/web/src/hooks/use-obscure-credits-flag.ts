/**
 * Read seam for the `obscure-credits` client flag, which swaps the billing
 * Plan section's dollar figures for a usage-relative view: a Usage Balance bar
 * in place of the current tile's price footer, and a credits spec chip that
 * names the package instead of a bundle amount.
 */

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/**
 * No pending state to wait on: the flag defaults off and a `false` read renders
 * today's Plan section, so the pre-hydration window already shows the correct
 * UI and only ever swaps forward once the real value lands.
 */
export function useObscureCredits(): boolean {
  return useClientFeatureFlagStore.use.obscureCredits();
}
