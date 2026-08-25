import { composeSvg } from "@/utils/avatar-svg-compositor";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

/**
 * Resolved avatar render instruction, in the priority order the assistant
 * avatar uses everywhere it appears (chat avatar, browser favicon, the
 * Electron dock/menu-bar icon):
 *
 *   1. `character` — an animated SVG composited from the assistant's traits.
 *   2. `image` — a custom uploaded image (blob URL or remote URL).
 *   3. `none` — no avatar; the consumer falls back to the Vellum mark.
 *
 * An assistant that has components but has never picked traits still draws a
 * character, the default one every surface derives through
 * {@link resolveEffectiveTraits}. It sits between the custom image and `none`
 * rather than at the top: a face nobody chose must not displace one they
 * uploaded.
 *
 * Returning the instruction (rather than a single pre-rendered string) lets
 * each surface consume it the way it needs: the favicon points a `<link>` at
 * the SVG data URI or image URL directly, while the Electron icon pipeline
 * rasterizes either source onto a canvas before shipping pixels to the main
 * process.
 */
export type AvatarRender =
  | { kind: "character"; svg: string; dataUri: string }
  | { kind: "image"; url: string }
  | { kind: "none" };

/**
 * The traits an assistant's character avatar is actually drawn with: its own
 * saved traits, or the default character built from the first body shape, eye
 * style and color of the served palette. Null when there is no character to
 * draw at all.
 *
 * An assistant that has never opened the avatar builder still shows a creature
 * rather than the Vellum mark, so the default has to be resolved in one place:
 * every surface that draws the assistant (the chat avatar, the favicon, the
 * Electron dock and menu-bar icons, the Live Activity island, the iOS Home
 * Screen widgets) must land on the same face.
 */
export function resolveEffectiveTraits(
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
): CharacterTraits | null {
  if (traits) {
    return traits;
  }
  if (!components) {
    return null;
  }
  const body = components.bodyShapes[0];
  const eyes = components.eyeStyles[0];
  const color = components.colors[0];
  if (!body || !eyes || !color) {
    return null;
  }
  return { bodyShape: body.id, eyeStyle: eyes.id, color: color.id };
}

/**
 * Composite the character, or null when the traits name components the palette
 * does not have. `composeSvg` throws on unknown trait IDs, which is treated as
 * "no character avatar available" rather than as an error.
 */
function composeCharacter(
  components: CharacterComponents,
  traits: CharacterTraits,
  size: number,
): AvatarRender | null {
  try {
    const svg = composeSvg(
      components,
      traits.bodyShape,
      traits.eyeStyle,
      traits.color,
      size,
    );
    return {
      kind: "character",
      svg,
      dataUri: `data:image/svg+xml,${encodeURIComponent(svg)}`,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve how the assistant's avatar should be rendered at a given pixel
 * size. The single source of truth for avatar-source precedence so the
 * favicon, the Electron icon pipeline, the Live Activity island and the iOS
 * widgets can never drift apart.
 *
 * The precedence matches `ChatAvatar`, which is what the user is looking at
 * while the other surfaces draw: saved traits outrank a custom image, but the
 * derived default does not, so an uploaded avatar is never displaced by a
 * creature its owner never chose.
 */
export function resolveAvatarRender(
  customImageUrl: string | null,
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
  size: number,
): AvatarRender {
  if (components && traits) {
    const character = composeCharacter(components, traits, size);
    if (character) {
      return character;
    }
  }

  if (customImageUrl) {
    return { kind: "image", url: customImageUrl };
  }

  // Traits that failed to composite above are not retried here: they are the
  // assistant's own choice, and the default is for an assistant that made none.
  if (components && !traits) {
    const defaultTraits = resolveEffectiveTraits(components, null);
    if (defaultTraits) {
      const character = composeCharacter(components, defaultTraits, size);
      if (character) {
        return character;
      }
    }
  }

  return { kind: "none" };
}
