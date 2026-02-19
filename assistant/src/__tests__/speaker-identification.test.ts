import { describe, expect, test } from 'bun:test';
import { extractPromptSpeakerMetadata, SpeakerIdentityTracker } from '../calls/speaker-identification.js';

describe('speaker-identification', () => {
  test('extractPromptSpeakerMetadata: reads top-level and nested fields', () => {
    const metadata = extractPromptSpeakerMetadata({
      speaker_id: 'spk-7',
      speaker_label: 'Conference room mic',
      speaker_confidence: '0.88',
      metadata: {
        participantId: 'participant-22',
      },
    });

    expect(metadata.speakerId).toBe('spk-7');
    expect(metadata.speakerLabel).toBe('Conference room mic');
    expect(metadata.speakerConfidence).toBe(0.88);
    expect(metadata.participantId).toBe('participant-22');
  });

  test('SpeakerIdentityTracker: keeps stable identity for provider speaker id', () => {
    const tracker = new SpeakerIdentityTracker();

    const first = tracker.identifySpeaker({
      speakerId: 'speaker-a',
      speakerName: 'Aaron',
      speakerConfidence: 0.93,
    });
    const second = tracker.identifySpeaker({
      speakerId: 'speaker-a',
      speakerName: 'Aaron',
      speakerConfidence: 0.81,
    });

    expect(first.speakerId).toBe('speaker-a');
    expect(first.speakerLabel).toBe('Aaron');
    expect(first.source).toBe('provider');
    expect(second.speakerId).toBe('speaker-a');
    expect(second.speakerLabel).toBe('Aaron');
    expect(second.speakerConfidence).toBe(0.81);
    expect(tracker.listProfiles()).toHaveLength(1);
  });

  test('SpeakerIdentityTracker: falls back to inferred primary speaker without provider ids', () => {
    const tracker = new SpeakerIdentityTracker();
    const speaker = tracker.identifySpeaker({});

    expect(speaker.speakerId).toBe('primary-speaker');
    expect(speaker.speakerLabel).toBe('Speaker 1');
    expect(speaker.source).toBe('inferred');
  });
});
