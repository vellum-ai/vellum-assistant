/**
 * Foreground tone for the avatar-tinted onboarding steps.
 *
 * SPIKE — research-onboarding flow.
 *
 * Those steps paint the background with the chosen avatar's color, so UI drawn
 * on top (top bar, titles, labels) needs a foreground that contrasts. The
 * derivation itself is the shared `toneForBg` (see `@/utils/surface-tone`);
 * this module binds it to the onboarding picker's chosen character.
 *
 * The picker / first form sit on the dark app surface (not an avatar color) and
 * should stay white regardless — they pass an explicit tone rather than using
 * this hook.
 */

import { useMemo } from "react";

import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { toneForBg, type SurfaceTone } from "@/utils/surface-tone";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

export type OnboardingTone = SurfaceTone;

export { toneForBg };

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
