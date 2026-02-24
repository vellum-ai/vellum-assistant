import { describe, expect, it } from 'bun:test';
import { detectRecordingIntent } from '../daemon/recording-intent.js';

describe('detectRecordingIntent', () => {
  describe('positive cases', () => {
    const positiveCases = [
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

    for (const input of positiveCases) {
      it(`detects recording intent: "${input}"`, () => {
        expect(detectRecordingIntent(input)).toBe(true);
      });
    }
  });

  describe('negative cases', () => {
    const negativeCases = [
      'open Safari',
      'check my email',
      'write a function',
      'what is the weather',
      'record in the database',
      'help me with this task',
      'open the recording app',
    ];

    for (const input of negativeCases) {
      it(`does not detect recording intent: "${input}"`, () => {
        expect(detectRecordingIntent(input)).toBe(false);
      });
    }
  });
});
