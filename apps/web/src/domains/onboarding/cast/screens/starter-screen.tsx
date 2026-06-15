/**
 * `starter` screen slot — character selection + name.
 *
 * Thin adapter between the orchestrator's `StarterScreenProps` contract
 * (`screen-slot.ts`) and the ported `CastStarter` sibling. `CastStarter` owns
 * the line-up → customization morph and its own internal "back to the line-up"
 * control; it surfaces the committed pick via `onChoose(character, name)` and
 * its open/closed customize state via `onCustomizing`.
 *
 * The orchestrator decides when to advance, so we forward `onChoose` straight
 * through and then call `onAdvance`. `onBack` is the flow-level predecessor
 * step (distinct from the in-screen line-up back button) and is left to the
 * orchestrator to surface where appropriate.
 */

import type { CastCharacter } from "@/domains/onboarding/cast/cast-roster";
import { CastStarter } from "@/domains/onboarding/cast/cast-starter";
import type { StarterScreenProps } from "@/domains/onboarding/cast/screens/screen-slot";

export function StarterScreen({
  resume,
  onAdvance,
  onChoose,
  onCustomizing,
}: StarterScreenProps) {
  const handleChoose = (character: CastCharacter, name: string) => {
    onChoose(character, name);
    onAdvance();
  };

  return (
    <CastStarter
      resume={resume}
      onChoose={handleChoose}
      onCustomizing={onCustomizing}
    />
  );
}
