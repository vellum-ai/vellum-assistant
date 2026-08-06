/**
 * Face-placement metrics for the empty-chat peeks (`ComposerPeek`).
 *
 * Body shapes carry their face at wildly different heights (ghost wears
 * it near the top of a tall body, sprout near the bottom under a tall
 * stem), and eye styles vary in ink height (gentle is nearly square,
 * grumpy is a flat strip). A fixed "show the top N pixels" crop
 * therefore hides some avatars' eyes entirely. These metrics express,
 * per body-shape + eye-style combination — including the catalog's
 * `faceCenterOverrides` — where the eye ink actually sits inside the
 * rendered square, so the peeks can size and crop every avatar such
 * that the eyes always ride the edge.
 *
 * The math mirrors `computeTransforms` / `AnimatedAvatar`'s layout
 * (body fit-centered into a square, eye art remapped onto the face
 * center) evaluated on a unit square, so the fractions hold at any
 * render size.
 */

import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { pathBBox, unionBBox } from "@/utils/eye-bbox";
import { resolveDefinitions } from "@/utils/avatar-svg-compositor";

export interface AvatarPeekMetrics {
  /** Vertical center of the eye ink, as a fraction of the square. */
  eyeCenterFrac: number;
  /** Half the eye ink's height, as a fraction of the square. */
  eyeHalfFrac: number;
}

/**
 * Metrics for the avatar described by `traits`, or null when the traits
 * don't resolve against the component catalog (unknown ids, custom
 * image). Callers fall back to neutral defaults on null.
 */
export function avatarPeekMetrics(
  components: CharacterComponents,
  traits: CharacterTraits,
): AvatarPeekMetrics | null {
  let resolved;
  try {
    resolved = resolveDefinitions(
      components,
      traits.bodyShape,
      traits.eyeStyle,
      traits.color,
    );
  } catch {
    return null;
  }
  const { bodyShape, eyeStyle } = resolved;
  if (!eyeStyle) {
    return null;
  }

  const vb = bodyShape.viewBox;
  // Body fit-centered into a unit square.
  const k = Math.min(1 / vb.width, 1 / vb.height);
  const bodyTy = (1 - vb.height * k) / 2;

  const override = components.faceCenterOverrides.find(
    (o) => o.bodyShape === bodyShape.id && o.eyeStyle === eyeStyle.id,
  );
  const faceCenter = override ? override.faceCenter : bodyShape.faceCenter;

  // Eye art remapped so its declared eyeCenter lands on the face center;
  // the ink's own bbox gives the true drawn extent (it can sit off the
  // declared center for asymmetric styles).
  const eyeVB = eyeStyle.sourceViewBox;
  const remapScale = Math.min(vb.width / eyeVB.width, vb.height / eyeVB.height);
  const ink = unionBBox(eyeStyle.paths.map((p) => pathBBox(p.svgPath)));
  const inkCenterY = ink.y + ink.h / 2;

  const eyeCenterFrac =
    k * (faceCenter.y + (inkCenterY - eyeStyle.eyeCenter.y) * remapScale) +
    bodyTy;
  const eyeHalfFrac = (ink.h * remapScale * k) / 2;

  return { eyeCenterFrac, eyeHalfFrac };
}
