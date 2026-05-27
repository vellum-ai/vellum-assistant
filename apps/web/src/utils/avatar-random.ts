/**
 * Generate random character traits for the hatching avatar. The trait
 * space is defined by the bundled character components: body shapes,
 * eye styles, and colors. Each axis is sampled uniformly at random.
 */
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

export function randomCharacterTraits(
  components: CharacterComponents,
): CharacterTraits {
  const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
  return {
    bodyShape: pick(components.bodyShapes).id,
    eyeStyle: pick(components.eyeStyles).id,
    color: pick(components.colors).id,
  };
}
