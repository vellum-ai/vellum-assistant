/**
 * Cast — activation-surface prototype.
 *
 * A curated roster of characters built from the existing avatar vocabulary
 * (`BUNDLED_COMPONENTS`: body shape + eye style + color). This is the visual
 * baseline — the same "dudes" the avatar builder produces — so the prototype
 * proves personality with the real art, not stand-in sketches.
 *
 * Each character has:
 *  - a hardcoded `name` keyed to its body+eyes combination (Beat 2),
 *  - a one-shot `hover` animation that previews personality (Beat 1),
 *  - a `reaction` derived from its eye style (Beat 2 autonomous beat).
 */

import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

export const COMPONENTS = BUNDLED_COMPONENTS;

/** One-shot animations a tile plays on hover. */
export type HoverAnim = "jump" | "flip" | "wiggle" | "spin";

/**
 * Autonomous Beat-2 reaction, keyed to the eye style so expression and motion
 * agree. These avatars are a single composited SVG (no limbs), so reactions
 * are whole-character motion: "crosses arms" reads as a defiant huff, "yawns"
 * as a slow stretch, etc.
 */
export type Reaction =
  | "huff" // angry — defiant, arms-crossed energy
  | "yawn" // grumpy — bored stretch
  | "peer" // curious — looks left and right
  | "spin" // goofy — gleeful spin
  | "startle" // surprised — jump
  | "shy" // bashful — leans away, peeking
  | "sway" // gentle — soft sway
  | "tilt" // quirky — offbeat head tilt
  | "woozy"; // dazed — woozy circle

const REACTION_BY_EYES: Record<string, Reaction> = {
  angry: "huff",
  grumpy: "yawn",
  curious: "peer",
  goofy: "spin",
  surprised: "startle",
  bashful: "shy",
  gentle: "sway",
  quirky: "tilt",
  dazed: "woozy",
};

export interface CastCharacter {
  id: string;
  name: string;
  bodyShape: string;
  eyeStyle: string;
  color: string;
  hover: HoverAnim;
  reaction: Reaction;
}

const HOVERS: HoverAnim[] = ["jump", "flip", "wiggle", "spin"];

/**
 * Roster definition. Names are pre-assigned per body+eyes combination. Covers
 * the brief's required bodies (blob, cloud, sprout, star + more) and eyes
 * (grumpy, angry, curious, goofy + more). The reaction is derived, not stored,
 * so it can never drift from the eyes.
 */
const ROSTER: Array<Omit<CastCharacter, "hover" | "reaction">> = [
  { id: "mossback", name: "Mossback", bodyShape: "blob", eyeStyle: "grumpy", color: "green" },
  { id: "nimbus", name: "Nimbus", bodyShape: "cloud", eyeStyle: "goofy", color: "teal" },
  { id: "sprig", name: "Sprig", bodyShape: "sprout", eyeStyle: "curious", color: "yellow" },
  { id: "blaze", name: "Blaze", bodyShape: "star", eyeStyle: "angry", color: "orange" },
  { id: "whisper", name: "Whisper", bodyShape: "ghost", eyeStyle: "bashful", color: "purple" },
  { id: "prickle", name: "Prickle", bodyShape: "urchin", eyeStyle: "quirky", color: "pink" },
  { id: "waffles", name: "Waffles", bodyShape: "stack", eyeStyle: "gentle", color: "green" },
  { id: "daisy", name: "Daisy", bodyShape: "flower", eyeStyle: "surprised", color: "pink" },
  { id: "comet", name: "Comet", bodyShape: "burst", eyeStyle: "dazed", color: "orange" },
  { id: "pip", name: "Pip", bodyShape: "ninja", eyeStyle: "curious", color: "purple" },
];

export const CAST: CastCharacter[] = ROSTER.map((c, i) => ({
  ...c,
  hover: HOVERS[i % HOVERS.length],
  reaction: REACTION_BY_EYES[c.eyeStyle] ?? "sway",
}));
