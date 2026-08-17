/**
 * The onboarding backdrop's peeking eyes: {@link PeekingEyes} driven by the
 * avatar picker's chosen character and the onboarding stage box, shared by the
 * Introduction and "How should I talk?" steps for continuity.
 *
 * SPIKE - research-onboarding flow.
 */

import { useMemo } from "react";

import { PeekingEyes } from "@/components/avatar/peeking-eyes";
import { useOnboardingStageSize } from "@/domains/onboarding/hooks/use-onboarding-stage-size";
import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { pathBBox, unionBBox } from "@/utils/eye-bbox";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

/**
 * The onboarding stage's bottom edge sits above where the eyes should read as
 * cut off, so they sink a further 5% of stage height below rest.
 */
const REST_SINK_FRACTION = 0.05;

interface OnboardingPeekingEyesProps {
  /** Play the grow-in entrance (Introduction). Otherwise the eyes are at rest. */
  entrance?: boolean;
  /** Delay before the entrance starts (lets the body cover the screen first). */
  entranceDelay?: number;
  /**
   * Increment to make the eyes jolt upward once (a Mario-style "bump", e.g. to
   * knock the integration-step coin up).
   */
  bumpNonce?: number;
}

export function OnboardingPeekingEyes({
  entrance = false,
  entranceDelay = 0,
  bumpNonce = 0,
}: OnboardingPeekingEyesProps) {
  const components = useBundledAvatarComponents();
  const characters = useOnboardingAvatarPoolStore.use.characters();
  const selectedIndex = useOnboardingAvatarPoolStore.use.selectedIndex();
  const stage = useOnboardingStageSize();

  const chosen = characters.length > 0 ? characters[selectedIndex] : undefined;

  const art = useMemo(() => {
    if (!components || !chosen) {
      return null;
    }
    const def = components.eyeStyles.find((e) => e.id === chosen.eyeStyle);
    if (!def) {
      return null;
    }
    return {
      paths: def.paths,
      bbox: unionBBox(def.paths.map((p) => pathBBox(p.svgPath))),
    };
  }, [components, chosen]);

  if (!art) {
    return null;
  }

  return (
    <PeekingEyes
      art={art}
      stage={stage}
      entrance={entrance}
      entranceDelay={entranceDelay}
      restSinkFraction={REST_SINK_FRACTION}
      bumpNonce={bumpNonce}
    />
  );
}
