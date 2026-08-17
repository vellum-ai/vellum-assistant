/**
 * The five personality trait axes shown on the personality page, each a
 * 0–100 slider flanked by its end labels. The ids mirror
 * `PERSONALITY_AXIS_IDS` in `@/assistant/personality-rewrite` —
 * `buildPersonalityMessage` reads the slider values by these exact ids,
 * with 0 = the left label and 100 = the right label.
 */

import { PERSONALITY_SLIDER_DEFAULT } from "@/assistant/personality-sliders";

export interface PersonalityAxisDefinition {
  id: string;
  leftKey:
    | "personalityAxes.companionCoworker.left"
    | "personalityAxes.genzBoomer.left"
    | "personalityAxes.executeCollaborate.left"
    | "personalityAxes.playfulSerious.left"
    | "personalityAxes.politeUnfiltered.left";
  rightKey:
    | "personalityAxes.companionCoworker.right"
    | "personalityAxes.genzBoomer.right"
    | "personalityAxes.executeCollaborate.right"
    | "personalityAxes.playfulSerious.right"
    | "personalityAxes.politeUnfiltered.right";
}

export const PERSONALITY_AXES: PersonalityAxisDefinition[] = [
  {
    id: "companion-coworker",
    leftKey: "personalityAxes.companionCoworker.left",
    rightKey: "personalityAxes.companionCoworker.right",
  },
  {
    id: "genz-boomer",
    leftKey: "personalityAxes.genzBoomer.left",
    rightKey: "personalityAxes.genzBoomer.right",
  },
  {
    id: "execute-collaborate",
    leftKey: "personalityAxes.executeCollaborate.left",
    rightKey: "personalityAxes.executeCollaborate.right",
  },
  {
    id: "playful-serious",
    leftKey: "personalityAxes.playfulSerious.left",
    rightKey: "personalityAxes.playfulSerious.right",
  },
  {
    id: "polite-unfiltered",
    leftKey: "personalityAxes.politeUnfiltered.left",
    rightKey: "personalityAxes.politeUnfiltered.right",
  },
];

/** Sliders start centered — no axis is nudged either way until the user acts. */
export const PERSONALITY_AXIS_DEFAULT = PERSONALITY_SLIDER_DEFAULT;
