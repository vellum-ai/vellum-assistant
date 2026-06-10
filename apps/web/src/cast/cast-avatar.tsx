import { useMemo } from "react";

import type { CastCharacter } from "@/cast/cast-roster";
import { COMPONENTS } from "@/cast/cast-roster";
import { composeSvg } from "@/utils/avatar-svg-compositor";
import {
  resolveDefinitions,
  computeTransforms,
} from "@/utils/avatar-svg-compositor";

const AVATAR_SIZE = 240;

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

const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Like CastAvatar but with a CSS blink animation on the eye group.
 * The eye paths are wrapped in a `<g>` with a computed transform-origin
 * so the scaleY blink pivots around the eye center.
 */
export function BlinkingAvatar({
  bodyShapeId,
  eyeStyleId,
  colorId,
  size = AVATAR_SIZE,
}: {
  bodyShapeId: string;
  eyeStyleId: string;
  colorId: string;
  size?: number;
}) {
  const { bodyShape, eyeStyle, color } = useMemo(
    () => resolveDefinitions(COMPONENTS, bodyShapeId, eyeStyleId, colorId),
    [bodyShapeId, eyeStyleId, colorId],
  );

  const { bodyTransform, eyeTransform } = useMemo(
    () => computeTransforms(bodyShape, eyeStyle, COMPONENTS, size),
    [bodyShape, eyeStyle, size],
  );

  const eyeCenter = useMemo(() => {
    const bodyVB = bodyShape.viewBox;
    const bodyScale = Math.min(size / bodyVB.width, size / bodyVB.height);
    const bodyTx = (size - bodyVB.width * bodyScale) / 2;
    const bodyTy = (size - bodyVB.height * bodyScale) / 2;
    const override = COMPONENTS.faceCenterOverrides.find(
      (o) => o.bodyShape === bodyShape.id && o.eyeStyle === eyeStyle.id,
    );
    const faceCenter = override ? override.faceCenter : bodyShape.faceCenter;
    const eyeVB = eyeStyle.sourceViewBox;
    const remapScale = Math.min(bodyVB.width / eyeVB.width, bodyVB.height / eyeVB.height);
    const remapTx = faceCenter.x - eyeStyle.eyeCenter.x * remapScale;
    const remapTy = faceCenter.y - eyeStyle.eyeCenter.y * remapScale;
    const x = bodyScale * (remapTx + eyeStyle.eyeCenter.x * remapScale) + bodyTx;
    const y = bodyScale * (remapTy + eyeStyle.eyeCenter.y * remapScale) + bodyTy;
    return { x, y };
  }, [bodyShape, eyeStyle, size]);

  return (
    <div className="cast-avatar" aria-hidden>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
      >
        <path d={bodyShape.svgPath} fill={color.hex} transform={bodyTransform} />
        <g
          style={{
            transformOrigin: `${eyeCenter.x}px ${eyeCenter.y}px`,
            animation: "cast-gaze-blink 4s ease-in-out infinite",
          }}
        >
          {eyeStyle.paths.map((p, i) => (
            <path key={i} d={escapeAttr(p.svgPath)} fill={p.color} transform={eyeTransform} />
          ))}
        </g>
      </svg>
    </div>
  );
}
