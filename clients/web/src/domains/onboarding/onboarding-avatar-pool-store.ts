/**
 * Shared pool of randomly-generated avatar characters for the onboarding flow.
 *
 * SPIKE — research-onboarding flow.
 *
 * The research form scatters these 10 characters, cut off, around the screen
 * edges; the upcoming "Give me a face and a name" step cycles through the same
 * pool (one selected in the center, the rest peeking at the edges). Keeping the
 * pool — and which one is selected — in a store lets both steps render the same
 * characters and lets the picker animate a character from its edge slot into the
 * center and back.
 *
 * The cast is a fixed, hand-picked set (not random) so the scene is consistent
 * across sessions and matches the design. Index 0 is the picker's initial
 * centered avatar.
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

/** How many characters to scatter / cycle through. */
export const AVATAR_POOL_SIZE = 12;

/**
 * The hand-picked cast, chosen to match the design. Spans all 9 body shapes and
 * all 9 eye styles (a few unavoidably repeat across 12 characters) so the picker
 * shows the full variety instead of leaning on the same faces. Index 0 is the
 * picker's initial centered avatar.
 */
// Index 0 is the center; indices 1–11 fill the picker's edge slots in order (see
// `edgeSlots` in onboarding-character-stage). Tuned to match the design.
const HARDCODED_POOL: CharacterTraits[] = [
  { bodyShape: "urchin", eyeStyle: "goofy", color: "teal" }, // center: teal spiky
  { bodyShape: "blob", eyeStyle: "grumpy", color: "purple" }, // top-left: purple blob
  { bodyShape: "star", eyeStyle: "surprised", color: "orange" }, // top L: orange star
  { bodyShape: "blob", eyeStyle: "gentle", color: "pink" }, // top R: pink blob
  { bodyShape: "ninja", eyeStyle: "angry", color: "yellow" }, // top-right: yellow angular
  { bodyShape: "urchin", eyeStyle: "curious", color: "pink" }, // right lower: pink spiky
  { bodyShape: "burst", eyeStyle: "quirky", color: "orange" }, // bottom-right: orange burst
  { bodyShape: "ghost", eyeStyle: "bashful", color: "green" }, // bottom-left: green sleepy
  { bodyShape: "sprout", eyeStyle: "dazed", color: "orange" }, // left mid: orange-red
  { bodyShape: "star", eyeStyle: "goofy", color: "teal" }, // right upper: teal star
  { bodyShape: "flower", eyeStyle: "angry", color: "pink" }, // bottom L of center: pink flower
  { bodyShape: "cloud", eyeStyle: "curious", color: "yellow" }, // bottom R of center: yellow cloud
];

interface OnboardingAvatarPoolState {
  /** The cast; empty until `ensureGenerated` runs. */
  characters: CharacterTraits[];
  /** Index of the character shown as the selected/center avatar in the picker. */
  selectedIndex: number;
  /** Populate the pool once (no-op if already done). */
  ensureGenerated: (components: CharacterComponents) => void;
  setSelectedIndex: (index: number) => void;
  selectNext: () => void;
  selectPrev: () => void;
}

const useOnboardingAvatarPoolStoreBase = create<OnboardingAvatarPoolState>(
  (set, get) => ({
    characters: [],
    selectedIndex: 0,
    ensureGenerated: () => {
      if (get().characters.length > 0) return;
      set({ characters: HARDCODED_POOL, selectedIndex: 0 });
    },
    setSelectedIndex: (index) => set({ selectedIndex: index }),
    selectNext: () =>
      set((s) => ({
        selectedIndex:
          s.characters.length === 0
            ? 0
            : (s.selectedIndex + 1) % s.characters.length,
      })),
    selectPrev: () =>
      set((s) => ({
        selectedIndex:
          s.characters.length === 0
            ? 0
            : (s.selectedIndex - 1 + s.characters.length) % s.characters.length,
      })),
  }),
);

export const useOnboardingAvatarPoolStore = createSelectors(
  useOnboardingAvatarPoolStoreBase,
);
