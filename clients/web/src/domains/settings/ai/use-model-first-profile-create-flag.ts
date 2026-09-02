/**
 * Read seam for the `model-first-profile-create` client flag, which decides
 * which question the New Model modal asks first: the provider, or the model.
 */

import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/**
 * No pending state to wait on: the flag defaults off and a `false` read
 * renders the provider-first flow, which is a working create form on its own,
 * so the pre-hydration window is never blank. The value is read on every
 * render rather than latched, because the two flows are alternative ways to
 * fill the same editor state and neither holds work the other would strand.
 */
export function useModelFirstProfileCreate(): boolean {
  return useClientFeatureFlagStore.use.modelFirstProfileCreate();
}
