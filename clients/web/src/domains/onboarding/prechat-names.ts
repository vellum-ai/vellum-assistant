/**
 * Personality groups and assistant-name pools for the onboarding name step.
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

export type AssistantNamingSource = "randomized" | "custom";

export const RESEARCH_NAMING_VARIANTS = {
  randomized: "random_initial",
  custom: "custom_name",
} as const;

const SUGGESTION_COUNT = 6;

export function allAssistantNames(): string[] {
  return PERSONALITY_GROUPS.flatMap((group) => group.names);
}

export function pickAssistantName(
  options: { exclude?: string; random?: () => number } = {},
): string {
  const names = allAssistantNames();
  const random = options.random ?? Math.random;
  const candidates = options.exclude
    ? names.filter((name) => name !== options.exclude)
    : names;
  const pool = candidates.length > 0 ? candidates : names;
  return pool[Math.floor(random() * pool.length)] ?? names[0] ?? "";
}

/**
 * Return `SUGGESTION_COUNT` unique names sampled uniformly at random from
 * the full 24-name pool (all personality groups). Uses a Fisher-Yates
 * partial shuffle. The result is stable per call. Callers should memoize
 * with `useMemo` or `useState` to persist across re-renders.
 */
export function sampleSuggestionNames(
  random: () => number = Math.random,
): string[] {
  const pool = allAssistantNames();
  const count = Math.min(SUGGESTION_COUNT, pool.length);
  for (let i = 0; i < count; i += 1) {
    const j = i + Math.floor(random() * (pool.length - i));
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return pool.slice(0, count);
}
