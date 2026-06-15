/**
 * Beat 3/4 content: the job choices ("What will I be doing for you?") and the
 * "rather" choices ("What would you rather be doing right now?"), plus the
 * off-screen edges props fly in from.
 */

import type { Reaction } from "@/domains/onboarding/cast/cast-roster";

/**
 * Inlined from the excluded `cast-prop-art` module. The art component
 * (`CastProp`) is a marketing/demo asset outside this PR's scope, but the pure
 * `PropKey` union is needed here to key job/rather icons and props. Inlining the
 * union keeps these data modules free of the excluded component closure.
 */
export type PropKey =
  | "laptop"
  | "pen"
  | "brush"
  | "headset"
  | "clipboard"
  | "book"
  | "stethoscope"
  | "hammer"
  | "sunglasses"
  | "backpack"
  | "chefhat"
  | "gamepad"
  | "plane"
  | "moon"
  | "buddies";

export type JobKey =
  | "building"
  | "writing"
  | "designing"
  | "fundraising"
  | "operating"
  | "teaching"
  | "healing"
  | "making";

export interface JobChoice {
  key: JobKey;
  label: string;
  prop: PropKey; // tile icon AND the prop that flies in / stays held
  /** Fragment that follows "you'll get to help me with …" in the locked input. */
  phrase: string;
}

export const JOBS: JobChoice[] = [
  { key: "building", label: "Building", prop: "laptop", phrase: "building" },
  { key: "writing", label: "Writing", prop: "pen", phrase: "writing" },
  { key: "designing", label: "Designing", prop: "brush", phrase: "design" },
  { key: "fundraising", label: "Fundraising", prop: "headset", phrase: "fundraising" },
  { key: "operating", label: "Operating", prop: "clipboard", phrase: "operations" },
  { key: "teaching", label: "Teaching", prop: "book", phrase: "teaching" },
  { key: "healing", label: "Healing", prop: "stethoscope", phrase: "healing" },
  { key: "making", label: "Making", prop: "hammer", phrase: "making things" },
];

export type RatherKey =
  | "beach"
  | "sleeping"
  | "reading"
  | "hiking"
  | "cooking"
  | "gaming"
  | "traveling"
  | "friends";

/** Where a prop settles relative to the character. ("held" is the job prop.) */
export type Placement = "held" | "face" | "top" | "front" | "back" | "across" | "none";

export interface RatherChoice {
  key: RatherKey;
  label: string;
  icon: PropKey; // tile icon
  /** Fragment that follows "I'd rather be …" in the locked input (grammatical:
   *  "at the beach", not "beach"). */
  phrase: string;
  mime: {
    prop?: PropKey; // prop that flies in for the mime (omit for special beats)
    place: Placement;
    replaceJob?: boolean; // hide the held job prop while the mime plays
    reaction?: Reaction; // also play this body reaction (e.g. sleeping → yawn)
    buddies?: boolean; // spawn little companion dudes beside (with friends)
  };
}

export const RATHERS: RatherChoice[] = [
  { key: "beach", label: "Beach", icon: "sunglasses", phrase: "at the beach", mime: { prop: "sunglasses", place: "face" } },
  { key: "sleeping", label: "Sleeping", icon: "moon", phrase: "asleep", mime: { place: "none", reaction: "yawn" } },
  { key: "reading", label: "Reading", icon: "book", phrase: "reading", mime: { prop: "book", place: "front", replaceJob: true } },
  { key: "hiking", label: "Hiking", icon: "backpack", phrase: "out hiking", mime: { prop: "backpack", place: "back" } },
  { key: "cooking", label: "Cooking", icon: "chefhat", phrase: "cooking", mime: { prop: "chefhat", place: "top" } },
  { key: "gaming", label: "Gaming", icon: "gamepad", phrase: "gaming", mime: { prop: "gamepad", place: "front" } },
  { key: "traveling", label: "Traveling", icon: "plane", phrase: "traveling", mime: { prop: "plane", place: "across" } },
  { key: "friends", label: "With friends", icon: "buddies", phrase: "with friends", mime: { place: "none", buddies: true } },
];

/**
 * Assemble the locked-input message from the current selections, in stable
 * JOBS/RATHERS order (not tap order) so re-tapping never reshuffles the text.
 */
export function assembleJobMessage(keys: JobKey[]): string {
  const parts = JOBS.filter((j) => keys.includes(j.key)).map((j) => j.phrase);
  if (parts.length === 0) return "";
  return `you'll get to help me with ${parts.join(", and ")}`;
}

export function assembleRatherMessage(keys: RatherKey[]): string {
  const parts = RATHERS.filter((r) => keys.includes(r.key)).map((r) => r.phrase);
  if (parts.length === 0) return "";
  return `and I'd rather be ${parts.join(", ")}`;
}

/**
 * Off-screen fly-in directions (unit-ish vectors + a landing rotation), cycled
 * per tap so each prop enters from a different edge. Actual start distance is
 * scaled to the viewport in the flying-prop component.
 */
export interface Edge {
  dx: number;
  dy: number;
  rot: number;
}

export const EDGES: Edge[] = [
  { dx: -1, dy: -0.72, rot: -42 }, // top-left
  { dx: 1, dy: 0.72, rot: 40 }, // bottom-right
  { dx: 1, dy: -0.72, rot: 38 }, // top-right
  { dx: -1, dy: 0.72, rot: -38 }, // bottom-left
  { dx: 0, dy: -1, rot: 16 }, // top
  { dx: 1, dy: 0, rot: 30 }, // right
  { dx: -1, dy: 0, rot: -30 }, // left
  { dx: 0, dy: 1, rot: -16 }, // bottom
];
