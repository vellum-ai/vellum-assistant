/**
 * Curated voices offered by Vellum managed TTS (Deepgram Aura-2).
 *
 * The platform gates voices by its billing rate card, so this list must stay
 * a subset of the rate-carded models in vellum-assistant-platform
 * (`BILLING_MANAGED_SPEECH_RATE_CARDS`) — an unlisted model is rejected with
 * `missing_price`. Sample URLs are Deepgram's public hosted previews.
 */
export interface ManagedVoice {
  /** Deepgram model id, e.g. "aura-2-thalia-en". */
  model: string;
  label: string;
  description: string;
  sampleUrl: string;
}

export const DEFAULT_MANAGED_VOICE = "aura-2-thalia-en";

function sample(name: string): string {
  return `https://static.deepgram.com/examples/Aura-2-${name}.wav`;
}

export const MANAGED_VOICES: ManagedVoice[] = [
  {
    model: "aura-2-thalia-en",
    label: "Thalia (default)",
    description: "American · clear, confident, energetic",
    sampleUrl: sample("thalia"),
  },
  {
    model: "aura-2-andromeda-en",
    label: "Andromeda",
    description: "American · casual, expressive, comfortable",
    sampleUrl: sample("andromeda"),
  },
  {
    model: "aura-2-helena-en",
    label: "Helena",
    description: "American · caring, natural, friendly",
    sampleUrl: sample("helena"),
  },
  {
    model: "aura-2-athena-en",
    label: "Athena",
    description: "American · calm, smooth, professional",
    sampleUrl: sample("athena"),
  },
  {
    model: "aura-2-luna-en",
    label: "Luna",
    description: "American · friendly, natural, engaging",
    sampleUrl: sample("luna"),
  },
  {
    model: "aura-2-pandora-en",
    label: "Pandora",
    description: "British · smooth, calm, melodic",
    sampleUrl: sample("pandora"),
  },
  {
    model: "aura-2-theia-en",
    label: "Theia",
    description: "Australian · expressive, polite, sincere",
    sampleUrl: sample("theia"),
  },
  {
    model: "aura-2-apollo-en",
    label: "Apollo",
    description: "American · confident, comfortable, casual",
    sampleUrl: sample("apollo"),
  },
  {
    model: "aura-2-arcas-en",
    label: "Arcas",
    description: "American · natural, smooth, clear",
    sampleUrl: sample("arcas"),
  },
  {
    model: "aura-2-zeus-en",
    label: "Zeus",
    description: "American · deep, trustworthy, smooth",
    sampleUrl: sample("zeus"),
  },
  {
    model: "aura-2-draco-en",
    label: "Draco",
    description: "British · warm, approachable, baritone",
    sampleUrl: sample("draco"),
  },
  {
    model: "aura-2-hyperion-en",
    label: "Hyperion",
    description: "Australian · caring, warm, empathetic",
    sampleUrl: sample("hyperion"),
  },
];
