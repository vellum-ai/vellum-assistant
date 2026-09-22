/**
 * The five personality trait axes shown on the personality page, each a
 * 0–100 slider flanked by its end labels. The ids come from
 * `@vellumai/assistant-api` so they stay aligned with the sidecar
 * path and the assistant's hosted-Qwen direction mapper. 0 = the left label
 * and 100 = the right label.
 */

import {
  PERSONALITY_AXIS_IDS,
  PERSONALITY_SLIDER_DEFAULT,
} from "@vellumai/assistant-api";

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
    id: PERSONALITY_AXIS_IDS.companionCoworker,
    leftKey: "personalityAxes.companionCoworker.left",
    rightKey: "personalityAxes.companionCoworker.right",
  },
  {
    id: PERSONALITY_AXIS_IDS.genzBoomer,
    leftKey: "personalityAxes.genzBoomer.left",
    rightKey: "personalityAxes.genzBoomer.right",
  },
  {
    id: PERSONALITY_AXIS_IDS.executeCollaborate,
    leftKey: "personalityAxes.executeCollaborate.left",
    rightKey: "personalityAxes.executeCollaborate.right",
  },
  {
    id: PERSONALITY_AXIS_IDS.playfulSerious,
    leftKey: "personalityAxes.playfulSerious.left",
    rightKey: "personalityAxes.playfulSerious.right",
  },
  {
    id: PERSONALITY_AXIS_IDS.politeUnfiltered,
    leftKey: "personalityAxes.politeUnfiltered.left",
    rightKey: "personalityAxes.politeUnfiltered.right",
  },
];

/** Sliders start centered — no axis is nudged either way until the user acts. */
export const PERSONALITY_AXIS_DEFAULT = PERSONALITY_SLIDER_DEFAULT;
