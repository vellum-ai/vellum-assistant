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
 * Upstream provider a managed voice is synthesized by.
 */
export type ManagedVoiceSource = "deepgram" | "elevenlabs";

// Keyed loosely (not by ManagedVoiceSource) so labels also resolve for
// sources that arrive from the platform voices endpoint before this file
// learns about them; callers fall back to the raw source string on a miss.
export const MANAGED_VOICE_SOURCE_LABELS: Record<string, string> = {
  deepgram: "Deepgram",
  elevenlabs: "ElevenLabs",
};

export interface ManagedVoice {
  /** Upstream model id, e.g. "aura-2-thalia-en". */
  model: string;
  label: string;
  description: string;
  sampleUrl: string;
  source: ManagedVoiceSource;
}

/**
 * Split a voice `description` ("American · calm, smooth, professional") into its
 * character traits and its accent. The traits are the distinguishing part, so
 * UIs lead with them and de-emphasize the accent; `traits` is also the natural
 * sort key. Falls back to the whole string as `traits` (empty accent) if the
 * expected " · " separator is absent.
 */
export function splitVoiceDescription(description: string): {
  traits: string;
  accent: string;
} {
  const separator = " · ";
  const index = description.indexOf(separator);
  if (index === -1) return { traits: description, accent: "" };
  return {
    accent: description.slice(0, index),
    traits: description.slice(index + separator.length),
  };
}

export const DEFAULT_MANAGED_VOICE = "EXAVITQu4vr4xnSDxMaL";

function sample(name: string): string {
  return `https://static.deepgram.com/examples/Aura-2-${name}.wav`;
}

const ELEVENLABS_PREVIEWS =
  "https://storage.googleapis.com/eleven-public-prod/premade/voices";

// Current ElevenLabs default ("premade") voices with their public hosted
// preview assets; legacy premades (Rachel, Domi, Josh, Antoni) are
// deliberately absent — the platform no longer offers them.
function elevenlabs(
  model: string,
  label: string,
  description: string,
  previewFile: string,
): ManagedVoice {
  return {
    model,
    label,
    description,
    source: "elevenlabs",
    sampleUrl: `${ELEVENLABS_PREVIEWS}/${model}/${previewFile}`,
  };
}

export const MANAGED_VOICES: ManagedVoice[] = [
  elevenlabs(
    "EXAVITQu4vr4xnSDxMaL",
    "Sarah",
    "American · professional, reassuring, confident",
    "01a3e33c-6e99-4ee7-8543-ff2216a32186.mp3",
  ),
  elevenlabs(
    "CwhRBWXzGAHq8TQ4Fs17",
    "Roger",
    "American · laid-back, casual, resonant",
    "58ee3ff5-f6f2-4628-93b8-e38eb31806b0.mp3",
  ),
  elevenlabs(
    "Xb7hH8MSUJpSbSDYk0k2",
    "Alice",
    "British · clear, engaging, professional",
    "d10f7534-11f6-41fe-a012-2de1e482d336.mp3",
  ),
  elevenlabs(
    "SAz9YHcvj6GT2YYXdXww",
    "River",
    "American · relaxed, neutral, informative",
    "e6c95f0b-2227-491a-b3d7-2249240decb7.mp3",
  ),
  elevenlabs(
    "cjVigY5qzO86Huf0OWal",
    "Eric",
    "American · smooth, trustworthy, classy",
    "d098fda0-6456-4030-b3d8-63aa048c9070.mp3",
  ),
  elevenlabs(
    "pNInz6obpgDQGcFmaJgB",
    "Adam",
    "American · deep, dominant, firm",
    "d6905d7a-dd26-4187-bfff-1bd3a5ea7cac.mp3",
  ),
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
