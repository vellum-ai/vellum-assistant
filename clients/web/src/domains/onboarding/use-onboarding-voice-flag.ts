/**
 * Reads the `voice-mode` flag for the BACKGROUND-HATCHED onboarding assistant.
 *
 * SPIKE — research-onboarding flow.
 *
 * The shared assistant-feature-flag store (`useAssistantFeatureFlagStore`) is
 * keyed to the app's *active* assistant, hydrated by `RootLayout`. Onboarding
 * hatches/adopts a SEPARATE assistant (`hatchedAssistantId`) and only selects it
 * at the final handoff — so reading the shared store during onboarding reports
 * the previously-selected assistant's value, or the registry default (`false`)
 * for a brand-new user with nothing selected, which would hide the audition for
 * exactly the users the flag targets.
 *
 * So query the hatched assistant's flags directly (mirroring
 * `useAssistantFeatureFlagSync`) and read voice-mode locally, WITHOUT writing to
 * the shared store (which must keep reflecting the active assistant). Returns
 * `false` until the hatch id is known and the flags land — fails safe.
 */

import { useQuery } from "@tanstack/react-query";

import { assistantFeatureFlagsGetOptions } from "@/generated/gateway/@tanstack/react-query.gen";
import { flagKeyToStoreKey } from "@/lib/feature-flags/feature-flag-catalog";
import { useFlagQueryFreshness } from "@/lib/backwards-compat/flag-query-freshness";

export function useOnboardingVoiceFlag(assistantId: string | null): boolean {
  const freshness = useFlagQueryFreshness();
  const { data } = useQuery({
    ...assistantFeatureFlagsGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: assistantId !== null,
    ...freshness,
    retry: 1,
  });
  return (
    data?.flags?.some(
      (flag) => flagKeyToStoreKey(flag.key) === "voiceMode" && flag.enabled === true,
    ) ?? false
  );
}
