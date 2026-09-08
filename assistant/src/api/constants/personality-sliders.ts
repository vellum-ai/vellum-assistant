/**
 * Personality slider sidecar path, the five 0-100 axis ids, and the
 * hosted-Qwen direction poles those sliders map onto.
 *
 * The web writes `data/personality-sliders.json`. The assistant reads the
 * same path and maps each slider onto one left/right pole. Both import
 * these constants from `@vellumai/assistant-api` so the ids cannot drift.
 */

/** Workspace-relative sidecar holding the five 0-100 slider values. */
export const PERSONALITY_SLIDERS_PATH = "data/personality-sliders.json";

/** Sliders start centered. Center is no steer on the hosted-Qwen route. */
export const PERSONALITY_SLIDER_DEFAULT = 50;

/**
 * Axis ids the personality sliders key their values by. Each is 0-100 with
 * 0 = the left label and 100 = the right label.
 */
export const PERSONALITY_AXIS_IDS = {
  companionCoworker: "companion-coworker",
  genzBoomer: "genz-boomer",
  executeCollaborate: "execute-collaborate",
  playfulSerious: "playful-serious",
  politeUnfiltered: "polite-unfiltered",
} as const;

export type PersonalityAxisId =
  (typeof PERSONALITY_AXIS_IDS)[keyof typeof PERSONALITY_AXIS_IDS];

/**
 * One-sided direction poles for each slider. Center (50) activates neither.
 * Values below 50 activate `left`; values above 50 activate `right`.
 */
export const PERSONALITY_DIRECTION_AXES = [
  {
    sliderId: PERSONALITY_AXIS_IDS.companionCoworker,
    left: "companion",
    right: "coworker",
  },
  {
    sliderId: PERSONALITY_AXIS_IDS.genzBoomer,
    left: "genz",
    right: "boomer",
  },
  {
    sliderId: PERSONALITY_AXIS_IDS.executeCollaborate,
    left: "independent",
    right: "collaborative",
  },
  {
    sliderId: PERSONALITY_AXIS_IDS.playfulSerious,
    left: "playful",
    right: "serious",
  },
  {
    sliderId: PERSONALITY_AXIS_IDS.politeUnfiltered,
    left: "polite",
    right: "unfiltered",
  },
] as const;

export type PersonalityDirectionAxis =
  (typeof PERSONALITY_DIRECTION_AXES)[number];
