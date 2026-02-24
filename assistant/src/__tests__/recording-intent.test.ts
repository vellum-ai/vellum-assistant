import { describe, test, expect } from 'bun:test';
import { detectRecordingIntent } from '../daemon/recording-intent.js';
import { detectQaIntent } from '../daemon/qa-intent.js';

describe('detectRecordingIntent', () => {
  // ── Positive cases ──────────────────────────────────────────────────────
  const positives = [
    'record my screen',
    'record the screen',
    'record screen',
    'Record my display',
    'record my desktop',
    'record my session',
    'screen record this',
    'screenrecord while I work',
    'capture my screen',
    'capture the display',
    'capture my desktop',
    'record this',
    'record while I work',
    'record what I do',
    'record me doing this',
    'start recording',
    'record a video',
    'record video of my workflow',
    'video record this session',
    'make a recording',
    'take a recording',
    'take a screen recording',
  ];

  for (const input of positives) {
    test(`detects: "${input}"`, () => {
      expect(detectRecordingIntent(input)).toBe(true);
    });
  }

  // ── Negative cases ──────────────────────────────────────────────────────
  const negatives = [
    'open Safari',
    'check my email',
    'write a function',
    'what is the weather',
    'record in the database',    // "record" without screen/display/etc.
    'help me with this task',
    'open the recording app',    // "recording" as noun, not a request
  ];

  for (const input of negatives) {
    test(`does not detect: "${input}"`, () => {
      expect(detectRecordingIntent(input)).toBe(false);
    });
  }

  // ── Mixed QA + recording ────────────────────────────────────────────────
  // These prompts contain both QA intent AND recording intent.
  // Both detectors should fire independently.
  describe('mixed QA + recording prompts', () => {
    const mixedPrompts = [
      'test this behavior and record the screen',
      'QA the login flow and record my screen',
      'verify the signup and start recording',
      'test the app — record video of the session',
    ];

    for (const input of mixedPrompts) {
      test(`"${input}" triggers both QA and recording intent`, () => {
        expect(detectQaIntent(input)).toBe(true);
        expect(detectRecordingIntent(input)).toBe(true);
      });
    }
  });
});

// ── Routing integration tests ─────────────────────────────────────────────
// These verify the requiresRecording computation logic from misc.ts
// without needing to spin up the full handler.
describe('requiresRecording computation', () => {
  // Mirrors the logic in handleTaskSubmit:
  //   const requiresRecording = msg.requiresRecording
  //     ?? (isRecordingRequested || (effectiveQa && config.qaRecording.enforceStartBeforeActions));
  function computeRequiresRecording(opts: {
    msgOverride?: boolean;
    isRecordingRequested: boolean;
    effectiveQa: boolean;
    enforceStartBeforeActions: boolean;
  }): boolean {
    return opts.msgOverride
      ?? (opts.isRecordingRequested || (opts.effectiveQa && opts.enforceStartBeforeActions));
  }

  test('standalone recording request → requiresRecording = true', () => {
    expect(computeRequiresRecording({
      isRecordingRequested: true,
      effectiveQa: false,
      enforceStartBeforeActions: false,
    })).toBe(true);
  });

  test('QA intent + enforceStartBeforeActions → requiresRecording = true', () => {
    expect(computeRequiresRecording({
      isRecordingRequested: false,
      effectiveQa: true,
      enforceStartBeforeActions: true,
    })).toBe(true);
  });

  test('QA intent without enforceStartBeforeActions → requiresRecording = false', () => {
    expect(computeRequiresRecording({
      isRecordingRequested: false,
      effectiveQa: true,
      enforceStartBeforeActions: false,
    })).toBe(false);
  });

  test('mixed QA + recording → requiresRecording = true regardless of config', () => {
    expect(computeRequiresRecording({
      isRecordingRequested: true,
      effectiveQa: true,
      enforceStartBeforeActions: false,
    })).toBe(true);
  });

  test('explicit msg.requiresRecording overrides computation', () => {
    expect(computeRequiresRecording({
      msgOverride: false,
      isRecordingRequested: true,
      effectiveQa: true,
      enforceStartBeforeActions: true,
    })).toBe(false);
  });

  test('no intent, no QA, no override → requiresRecording = false', () => {
    expect(computeRequiresRecording({
      isRecordingRequested: false,
      effectiveQa: false,
      enforceStartBeforeActions: true,
    })).toBe(false);
  });
});
