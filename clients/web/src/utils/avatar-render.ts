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
 * Resolve how the assistant's avatar should be rendered at a given pixel
 * size. The single source of truth for avatar-source precedence so the
 * favicon and the Electron icon pipeline can never drift apart.
 *
 * `composeSvg` throws on unknown trait IDs; that is treated as "no character
 * avatar available" and falls through to the custom image, matching the chat
 * avatar's behavior.
 */
export function resolveAvatarRender(
  customImageUrl: string | null,
  components: CharacterComponents | null,
  traits: CharacterTraits | null,
  size: number,
): AvatarRender {
  if (components && traits) {
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
      // Unknown trait IDs — fall through to the custom image or none.
    }
  }

  if (customImageUrl) {
    return { kind: "image", url: customImageUrl };
  }

  return { kind: "none" };
}
