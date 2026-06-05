/**
 * Beat 3/4 content: the job choices ("What will I be doing for you?") and the
 * "rather" choices ("What would you rather be doing right now?"), plus the
 * off-screen edges props fly in from.
 */

import type { PropKey } from "@/cast/cast-prop-art";
import type { Reaction } from "@/cast/cast-roster";

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
}

export const JOBS: JobChoice[] = [
  { key: "building", label: "Building", prop: "laptop" },
  { key: "writing", label: "Writing", prop: "pen" },
  { key: "designing", label: "Designing", prop: "brush" },
  { key: "fundraising", label: "Fundraising", prop: "headset" },
  { key: "operating", label: "Operating", prop: "clipboard" },
  { key: "teaching", label: "Teaching", prop: "book" },
  { key: "healing", label: "Healing", prop: "stethoscope" },
  { key: "making", label: "Making", prop: "hammer" },
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
  mime: {
    prop?: PropKey; // prop that flies in for the mime (omit for special beats)
    place: Placement;
    replaceJob?: boolean; // hide the held job prop while the mime plays
    reaction?: Reaction; // also play this body reaction (e.g. sleeping → yawn)
    buddies?: boolean; // spawn little companion dudes beside (with friends)
  };
}

export const RATHERS: RatherChoice[] = [
  { key: "beach", label: "Beach", icon: "sunglasses", mime: { prop: "sunglasses", place: "face" } },
  { key: "sleeping", label: "Sleeping", icon: "moon", mime: { place: "none", reaction: "yawn" } },
  { key: "reading", label: "Reading", icon: "book", mime: { prop: "book", place: "front", replaceJob: true } },
  { key: "hiking", label: "Hiking", icon: "backpack", mime: { prop: "backpack", place: "back" } },
  { key: "cooking", label: "Cooking", icon: "chefhat", mime: { prop: "chefhat", place: "top" } },
  { key: "gaming", label: "Gaming", icon: "gamepad", mime: { prop: "gamepad", place: "front" } },
  { key: "traveling", label: "Traveling", icon: "plane", mime: { prop: "plane", place: "across" } },
  { key: "friends", label: "With friends", icon: "buddies", mime: { place: "none", buddies: true } },
];

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
