/**
 * Personality groups and assistant-name pools for the PreChat onboarding
 * name-exchange screen. Mirrors macOS `PersonalityGroup.swift` and
 * `PreChatOnboardingState.swift`.
 */

export interface PersonalityGroup {
  id: string;
  label: string;
  descriptor: string;
  tagline: string;
  names: string[];
}

export const PERSONALITY_GROUPS: readonly PersonalityGroup[] = [
  {
    id: "grounded",
    label: "Grounded",
    descriptor: "Calm and precise",
    tagline: "Measured. No filler.",
    names: ["Penn", "Sage", "Atlas", "Orion", "Reed", "Quill"],
  },
  {
    id: "warm",
    label: "Warm",
    descriptor: "Warm and easy",
    tagline: "Friendly and casual.",
    names: ["Kit", "Remy", "Wren", "Milo", "Fenn", "Cleo"],
  },
  {
    id: "energetic",
    label: "Energetic",
    descriptor: "Fast and direct",
    tagline: "Brief. To the point.",
    names: ["Nova", "Ember", "Cade", "Lark", "Vela", "Ziggy"],
  },
  {
    id: "poetic",
    label: "Poetic",
    descriptor: "Quiet and observant",
    tagline: "Listens, then replies.",
    names: ["Luna", "Iris", "Vesper", "Lyra", "Juno", "Ada"],
  },
];

export const DEFAULT_GROUP_ID = "grounded";

const SUGGESTION_COUNT = 6;

/**
 * All assistant names across every personality group.
 */
function allNames(): string[] {
  return PERSONALITY_GROUPS.flatMap((g) => g.names);
}

/**
 * Return `SUGGESTION_COUNT` unique names sampled uniformly at random from
 * the full 24-name pool (all personality groups). Uses a Fisher-Yates
 * partial shuffle. The result is stable per call — callers should memoize
 * with `useMemo` or `useState` to persist across re-renders.
 */
export function sampleSuggestionNames(): string[] {
  const pool = allNames();
  const count = Math.min(SUGGESTION_COUNT, pool.length);
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return pool.slice(0, count);
}
