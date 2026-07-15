/**
 * Foreground tone for the avatar-tinted onboarding steps.
 *
 * SPIKE — research-onboarding flow.
 *
 * The tone derivation itself is the shared `@/utils/avatar-tone` module
 * (the About Assistant pages tint the same way); this module binds it to
 * the onboarding picker pool — the tone follows whichever avatar the user
 * has currently selected.
 *
 * The picker / first form sit on the dark app surface (not an avatar
 * color) and should stay white regardless — they pass an explicit tone
 * rather than using this hook.
 */

import { useMemo } from "react";

import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { toneForBg, type AvatarTone } from "@/utils/avatar-tone";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

export { darkenHex, toneForBg } from "@/utils/avatar-tone";
export type OnboardingTone = AvatarTone;

/** Tone derived from the currently-chosen avatar's color. */
export function useOnboardingTone(): OnboardingTone {
  const components = useBundledAvatarComponents();
  const characters = useOnboardingAvatarPoolStore.use.characters();
  const selectedIndex = useOnboardingAvatarPoolStore.use.selectedIndex();
  return useMemo(() => {
    const chosen = characters[selectedIndex];
    const hex = components?.colors.find((c) => c.id === chosen?.color)?.hex;
    return toneForBg(hex ?? "var(--surface-base)");
  }, [components, characters, selectedIndex]);
}
