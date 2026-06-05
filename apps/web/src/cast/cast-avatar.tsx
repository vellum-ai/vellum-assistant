import { useMemo } from "react";

import type { CastCharacter } from "@/cast/cast-roster";
import { COMPONENTS } from "@/cast/cast-roster";
import { composeSvg } from "@/utils/avatar-svg-compositor";

/**
 * Renders a roster character as a container-filling SVG. We compose at a fixed
 * internal size and let CSS scale the `<svg>` to 100% of its box, so the
 * Beat-1 → Beat-2 layout morph (driven by framer's shared `layoutId`) zooms
 * cleanly instead of swapping art at two pixel sizes.
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
