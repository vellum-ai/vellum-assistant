/**
 * The five personality trait axes shown on the personality page, each a
 * 0–100 slider flanked by its end labels. The ids mirror
 * `PERSONALITY_AXIS_IDS` in `@/assistant/personality-rewrite` —
 * `buildPersonalityMessage` reads the slider values by these exact ids,
 * with 0 = the left label and 100 = the right label.
 */

export interface PersonalityAxisDefinition {
  id: string;
  left: string;
  right: string;
}

export const PERSONALITY_AXES: PersonalityAxisDefinition[] = [
  { id: "companion-coworker", left: "Companion", right: "Coworker" },
  { id: "genz-boomer", left: "Gen Z", right: "Baby Boomer" },
  { id: "execute-collaborate", left: "Independent", right: "Collaborative" },
  { id: "playful-serious", left: "Playful", right: "Serious" },
  { id: "polite-unfiltered", left: "Polite", right: "Unfiltered" },
];

/** Sliders start centered — no axis is nudged either way until the user acts. */
export const PERSONALITY_AXIS_DEFAULT = 50;
