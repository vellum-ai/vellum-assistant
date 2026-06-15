/**
 * `style` screen slot — the "how should I work" This-or-That rounds.
 *
 * Thin wrapper that adapts {@link CastStyle} (ported from the prototype) to the
 * {@link StyleScreenProps} screen-slot contract. The orchestrator owns phase
 * navigation, so the collected style profile is surfaced back through
 * `onRoundPicked` (per round) and `onDone` (final round); `onAdvance` is part of
 * the contract but not needed by the lightweight-avatar build of this screen.
 */
import { CastStyle } from "@/domains/onboarding/cast/cast-style";
import type { StyleScreenProps } from "@/domains/onboarding/cast/screens/screen-slot";

export function StyleScreen({
  character,
  name,
  heroBox,
  onChoose,
  onRoundPicked,
  onDone,
  onBack,
}: StyleScreenProps) {
  return (
    <CastStyle
      character={character}
      name={name}
      heroBox={heroBox}
      onChoose={onChoose}
      onRoundPicked={onRoundPicked}
      onDone={onDone}
      onBack={onBack}
    />
  );
}
