/**
 * Curated voices offered by Vellum managed TTS.
 *
 * The platform gates voices by its billing rate card, so this list must stay
 * a subset of the rate-carded models in vellum-assistant-platform
 * (`BILLING_MANAGED_SPEECH_RATE_CARDS`) — an unlisted model is rejected with
 * `missing_price`. Sample URLs are the upstream provider's public hosted
 * previews.
 */

/**
 * Upstream provider a managed voice is synthesized by. Extend as the
 * managed catalog grows (e.g. "elevenlabs").
 */
export type ManagedVoiceSource = "deepgram";

// Keyed loosely (not by ManagedVoiceSource) so labels also resolve for
// sources that arrive from the platform voices endpoint before this file
// learns about them; callers fall back to the raw source string on a miss.
export const MANAGED_VOICE_SOURCE_LABELS: Record<string, string> = {
  deepgram: "Deepgram",
};

export interface ManagedVoice {
  /** Upstream model id, e.g. "aura-2-thalia-en". */
  model: string;
  label: string;
  description: string;
  sampleUrl: string;
  source: ManagedVoiceSource;
}

export const DEFAULT_MANAGED_VOICE = "aura-2-thalia-en";

function sample(name: string): string {
  return `https://static.deepgram.com/examples/Aura-2-${name}.wav`;
}

export const MANAGED_VOICES: ManagedVoice[] = [
  {
    model: "aura-2-thalia-en",
    label: "Thalia",
    description: "American · clear, confident, energetic",
    source: "deepgram",
    sampleUrl: sample("thalia"),
  },
  {
    model: "aura-2-andromeda-en",
    label: "Andromeda",
    description: "American · casual, expressive, comfortable",
    source: "deepgram",
    sampleUrl: sample("andromeda"),
  },
  {
    model: "aura-2-helena-en",
    label: "Helena",
    description: "American · caring, natural, friendly",
    source: "deepgram",
    sampleUrl: sample("helena"),
  },
  {
    model: "aura-2-athena-en",
    label: "Athena",
    description: "American · calm, smooth, professional",
    source: "deepgram",
    sampleUrl: sample("athena"),
  },
  {
    model: "aura-2-luna-en",
    label: "Luna",
    description: "American · friendly, natural, engaging",
    source: "deepgram",
    sampleUrl: sample("luna"),
  },
  {
    model: "aura-2-pandora-en",
    label: "Pandora",
    description: "British · smooth, calm, melodic",
    source: "deepgram",
    sampleUrl: sample("pandora"),
  },
  {
    model: "aura-2-theia-en",
    label: "Theia",
    description: "Australian · expressive, polite, sincere",
    source: "deepgram",
    sampleUrl: sample("theia"),
  },
  {
    model: "aura-2-apollo-en",
    label: "Apollo",
    description: "American · confident, comfortable, casual",
    source: "deepgram",
    sampleUrl: sample("apollo"),
  },
  {
    model: "aura-2-arcas-en",
    label: "Arcas",
    description: "American · natural, smooth, clear",
    source: "deepgram",
    sampleUrl: sample("arcas"),
  },
  {
    model: "aura-2-zeus-en",
    label: "Zeus",
    description: "American · deep, trustworthy, smooth",
    source: "deepgram",
    sampleUrl: sample("zeus"),
  },
  {
    model: "aura-2-draco-en",
    label: "Draco",
    description: "British · warm, approachable, baritone",
    source: "deepgram",
    sampleUrl: sample("draco"),
  },
  {
    model: "aura-2-hyperion-en",
    label: "Hyperion",
    description: "Australian · caring, warm, empathetic",
    source: "deepgram",
    sampleUrl: sample("hyperion"),
  },
];
