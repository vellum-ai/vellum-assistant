/**
 * Roster-character avatar renderer.
 *
 * Ported from the prototype's `@/cast/cast-avatar`. Only `CastAvatar` is lifted
 * here — the prototype also exported a `BlinkingAvatar`, but base `cast-shell`
 * already ships an equivalent (keyed by `CastCharacter`), so the done screen
 * reuses that one and we avoid duplicating the blink closure. `CastAvatar` is
 * the static, container-filling variant the proof view renders (held dude +
 * artifact-overlay corner dude).
 *
 * Depends only on `cast-roster` (COMPONENTS) and the shared
 * `avatar-svg-compositor` util — both already on base — so no marketing/demo
 * closure is pulled in.
 */

import { useMemo } from "react";

import type { CastCharacter } from "@/domains/onboarding/cast/cast-roster";
import { COMPONENTS } from "@/domains/onboarding/cast/cast-roster";
import { composeSvg } from "@/utils/avatar-svg-compositor";

/**
 * Renders a roster character as a container-filling SVG. We compose at a fixed
 * internal size and let CSS scale the `<svg>` to 100% of its box.
 */
export function CastAvatar({ character }: { character: CastCharacter }) {
  const svg = useMemo(
    () =>
      composeSvg(
        COMPONENTS,
        character.bodyShape,
        character.eyeStyle,
        character.color,
        240,
      ),
    [character.bodyShape, character.eyeStyle, character.color],
  );

  return (
    <div
      className="cast-avatar"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
