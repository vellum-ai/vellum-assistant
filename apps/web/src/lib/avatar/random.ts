/**
 * Utilities for generating random character traits.
 *
 * Used during web hatch to assign the new assistant a default character
 * avatar — matching the macOS client which picks random body/eyes/color
 * at hatch time and syncs to the daemon.
 */

import type { CharacterTraits } from "@/lib/avatar/types.js";

/**
 * Body shape, eye style, and color IDs that mirror the daemon's
 * character-components catalog. These must stay in sync with
 * `assistant/src/avatar/character-components.ts`.
 */
const BODY_SHAPES = [
  "blob",
  "cloud",
  "sprout",
  "star",
  "ghost",
  "urchin",
  "stack",
  "flower",
  "burst",
  "ninja",
] as const;

const EYE_STYLES = [
  "grumpy",
  "angry",
  "curious",
  "goofy",
  "surprised",
  "bashful",
  "gentle",
  "quirky",
  "dazed",
] as const;

const COLORS = [
  "green",
  "orange",
  "pink",
  "purple",
  "teal",
  "yellow",
] as const;

function pickRandom<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

/**
 * Generate a random set of character traits suitable for a newly hatched
 * assistant. Each call produces an independent uniformly-random combination.
 */
export function randomCharacterTraits(): CharacterTraits {
  return {
    bodyShape: pickRandom(BODY_SHAPES),
    eyeStyle: pickRandom(EYE_STYLES),
    color: pickRandom(COLORS),
  };
}
