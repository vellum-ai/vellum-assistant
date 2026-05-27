/**
 * Deterministic avatar traits for subagents.
 *
 * Mirrors the macOS `SubagentAvatarProvider.traits(for:)` — hashes the
 * subagent ID to pick a stable body shape, eye style, and color so the
 * same subagent always renders the same avatar.
 */

import type { CharacterTraits } from "@/types/avatar";

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

/** Simple string hash (djb2) that produces a non-negative integer. */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return Math.abs(hash);
}

/**
 * Deterministically derive character traits from a subagent ID.
 * The same ID always produces the same traits.
 */
export function subagentTraits(subagentId: string): CharacterTraits {
  const hash = hashString(subagentId);
  return {
    bodyShape: BODY_SHAPES[hash % BODY_SHAPES.length]!,
    eyeStyle: EYE_STYLES[Math.floor(hash / 10) % EYE_STYLES.length]!,
    color: COLORS[Math.floor(hash / 100) % COLORS.length]!,
  };
}
