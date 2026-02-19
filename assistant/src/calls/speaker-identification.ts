export interface PromptSpeakerContext {
  speakerId: string;
  speakerLabel: string;
  speakerConfidence: number | null;
  source: 'provider' | 'inferred';
}

export interface PromptSpeakerMetadata {
  speakerId?: string;
  speakerLabel?: string;
  speakerName?: string;
  speakerConfidence?: number;
  participantId?: string;
}

interface SpeakerProfile {
  speakerId: string;
  speakerLabel: string;
  speakerConfidence: number | null;
  source: 'provider' | 'inferred';
  utteranceCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

function toCleanString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeSpeakerLabel(metadata: PromptSpeakerMetadata, fallbackIndex: number): string {
  const preferredLabel = toCleanString(metadata.speakerName) ?? toCleanString(metadata.speakerLabel);
  if (preferredLabel) return preferredLabel;
  return `Speaker ${fallbackIndex}`;
}

export function extractPromptSpeakerMetadata(message: Record<string, unknown>): PromptSpeakerMetadata {
  const providerMetadata = getObject(message.providerMetadata);
  const metadata = getObject(message.metadata);
  const participant = getObject(message.participant);
  const speaker = getObject(message.speaker);

  const pick = (...values: unknown[]): string | undefined => {
    for (const value of values) {
      const cleaned = toCleanString(value);
      if (cleaned) return cleaned;
    }
    return undefined;
  };

  const pickNumber = (...values: unknown[]): number | undefined => {
    for (const value of values) {
      const parsed = toNumber(value);
      if (parsed !== null) return parsed;
    }
    return undefined;
  };

  return {
    speakerId: pick(
      message.speakerId,
      message.speaker_id,
      speaker?.id,
      speaker?.speakerId,
      metadata?.speakerId,
      providerMetadata?.speakerId,
      metadata?.speaker_id,
      providerMetadata?.speaker_id,
    ),
    speakerLabel: pick(
      message.speakerLabel,
      message.speaker_label,
      message.speaker,
      speaker?.label,
      speaker?.name,
      metadata?.speakerLabel,
      providerMetadata?.speakerLabel,
      metadata?.speaker_label,
      providerMetadata?.speaker_label,
    ),
    speakerName: pick(
      message.speakerName,
      message.speaker_name,
      participant?.name,
      metadata?.speakerName,
      providerMetadata?.speakerName,
      metadata?.speaker_name,
      providerMetadata?.speaker_name,
    ),
    speakerConfidence: pickNumber(
      message.speakerConfidence,
      message.speaker_confidence,
      message.confidence,
      speaker?.confidence,
      metadata?.speakerConfidence,
      providerMetadata?.speakerConfidence,
      metadata?.speaker_confidence,
      providerMetadata?.speaker_confidence,
    ),
    participantId: pick(
      message.participantId,
      message.participant_id,
      participant?.id,
      metadata?.participantId,
      providerMetadata?.participantId,
      metadata?.participant_id,
      providerMetadata?.participant_id,
    ),
  };
}

export class SpeakerIdentityTracker {
  private profiles = new Map<string, SpeakerProfile>();
  private nextInferredIndex = 1;

  identifySpeaker(metadata: PromptSpeakerMetadata): PromptSpeakerContext {
    const providerSpeakerId =
      toCleanString(metadata.speakerId)
      ?? toCleanString(metadata.participantId)
      ?? null;

    if (providerSpeakerId) {
      const existing = this.profiles.get(providerSpeakerId);
      if (existing) {
        existing.lastSeenAt = Date.now();
        existing.utteranceCount += 1;
        if (metadata.speakerConfidence !== undefined) {
          existing.speakerConfidence = metadata.speakerConfidence;
        }
        return {
          speakerId: existing.speakerId,
          speakerLabel: existing.speakerLabel,
          speakerConfidence: existing.speakerConfidence,
          source: existing.source,
        };
      }

      const profile: SpeakerProfile = {
        speakerId: providerSpeakerId,
        speakerLabel: normalizeSpeakerLabel(metadata, this.nextInferredIndex),
        speakerConfidence: metadata.speakerConfidence ?? null,
        source: 'provider',
        utteranceCount: 1,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
      };
      this.profiles.set(providerSpeakerId, profile);
      this.nextInferredIndex += 1;
      return {
        speakerId: profile.speakerId,
        speakerLabel: profile.speakerLabel,
        speakerConfidence: profile.speakerConfidence,
        source: profile.source,
      };
    }

    const inferredSpeakerId = 'primary-speaker';
    const existingPrimary = this.profiles.get(inferredSpeakerId);
    if (existingPrimary) {
      existingPrimary.lastSeenAt = Date.now();
      existingPrimary.utteranceCount += 1;
      return {
        speakerId: existingPrimary.speakerId,
        speakerLabel: existingPrimary.speakerLabel,
        speakerConfidence: existingPrimary.speakerConfidence,
        source: existingPrimary.source,
      };
    }

    const inferredProfile: SpeakerProfile = {
      speakerId: inferredSpeakerId,
      speakerLabel: normalizeSpeakerLabel(metadata, this.nextInferredIndex),
      speakerConfidence: metadata.speakerConfidence ?? null,
      source: 'inferred',
      utteranceCount: 1,
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    this.profiles.set(inferredSpeakerId, inferredProfile);
    this.nextInferredIndex += 1;

    return {
      speakerId: inferredProfile.speakerId,
      speakerLabel: inferredProfile.speakerLabel,
      speakerConfidence: inferredProfile.speakerConfidence,
      source: inferredProfile.source,
    };
  }

  listProfiles(): PromptSpeakerContext[] {
    return [...this.profiles.values()].map((profile) => ({
      speakerId: profile.speakerId,
      speakerLabel: profile.speakerLabel,
      speakerConfidence: profile.speakerConfidence,
      source: profile.source,
    }));
  }
}
