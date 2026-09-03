/**
 * Personality groups and assistant-name pools for onboarding name selection.
 * Group labels stay here; the names themselves come from the locale-aware
 * pool so every region keeps a grounded, warm, energetic, and poetic set.
 */

import {
  DEFAULT_NAMING_REGION,
  PERSONALITY_GROUP_IDS,
  namesForRegion,
  sampleSuggestionNames as sampleLocaleSuggestionNames,
  type NamingRegion,
  type NamingSignals,
  type PersonalityGroupId,
} from "@/domains/onboarding/assistant-name-pool";

export interface PersonalityGroup {
  id: PersonalityGroupId;
  label: string;
  descriptor: string;
  tagline: string;
  names: string[];
}

const GROUP_META: Record<
  PersonalityGroupId,
  Pick<PersonalityGroup, "label" | "descriptor" | "tagline">
> = {
  grounded: {
    label: "Grounded",
    descriptor: "Calm and precise",
    tagline: "Measured. No filler.",
  },
  warm: {
    label: "Warm",
    descriptor: "Warm and easy",
    tagline: "Friendly and casual.",
  },
  energetic: {
    label: "Energetic",
    descriptor: "Fast and direct",
    tagline: "Brief. To the point.",
  },
  poetic: {
    label: "Poetic",
    descriptor: "Quiet and observant",
    tagline: "Listens, then replies.",
  },
};

export function personalityGroupsFor(
  region: NamingRegion = DEFAULT_NAMING_REGION,
): PersonalityGroup[] {
  const names = namesForRegion(region);
  return PERSONALITY_GROUP_IDS.map((id) => ({
    id,
    ...GROUP_META[id],
    names: [...names[id]],
  }));
}

export const PERSONALITY_GROUPS: readonly PersonalityGroup[] =
  personalityGroupsFor(DEFAULT_NAMING_REGION);

export const DEFAULT_GROUP_ID: PersonalityGroupId = "grounded";

export function sampleSuggestionNames(
  signals?: NamingSignals,
): string[] {
  return sampleLocaleSuggestionNames(signals);
}
