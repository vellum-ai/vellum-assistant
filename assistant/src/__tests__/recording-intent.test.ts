import { describe, expect, it } from 'bun:test';
import { detectRecordingIntent, stripRecordingIntent } from '../daemon/recording-intent.js';

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
      'take a video while you do this workflow',
      'video record this session',
      'make a recording',
      'take a recording',
      'take a screen recording',
      'capture this while I test',
      'screen capture this flow',
      'please film this',
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
      'capture this bug in code',
    ];

    for (const input of negativeCases) {
      it(`does not detect recording intent: "${input}"`, () => {
        expect(detectRecordingIntent(input)).toBe(false);
      });
    }
  });
});

describe('stripRecordingIntent', () => {
  it('removes recording directive and preserves workflow', () => {
    expect(stripRecordingIntent('Record my screen while you open Safari and navigate to example.com'))
      .toBe('you open Safari and navigate to example.com');
  });

  it('removes take-a-video phrasing', () => {
    expect(stripRecordingIntent('Take a video while you type hello in Notes'))
      .toBe('you type hello in Notes');
  });

  it('falls back when nothing remains', () => {
    expect(stripRecordingIntent('record my screen')).toBe('Perform the task shown on screen.');
  });
});
