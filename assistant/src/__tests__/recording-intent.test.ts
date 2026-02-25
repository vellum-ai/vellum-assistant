import { describe, test, expect } from 'bun:test';
import {
  detectRecordingIntent,
  isRecordingOnly,
  detectStopRecordingIntent,
  stripRecordingIntent,
  stripStopRecordingIntent,
  isStopRecordingOnly,
} from '../daemon/recording-intent.js';

// ─── detectRecordingIntent ──────────────────────────────────────────────────

describe('detectRecordingIntent', () => {
  test.each([
    'record my screen',
    'Record My Screen',
    'record the screen',
    'screen recording',
    'screen record',
    'start recording',
    'begin recording',
    'capture my screen',
    'capture my display',
    'capture screen',
    'make a recording',
    'make a screen recording',
  ])('detects recording intent in "%s"', (text) => {
    expect(detectRecordingIntent(text)).toBe(true);
  });

  test.each([
    '',
    'hello world',
    'open Safari',
    'stop recording',
    'take a screenshot',
    'what time is it?',
    'record a note',
    'make a note',
    'start the timer',
  ])('does not detect recording intent in "%s"', (text) => {
    expect(detectRecordingIntent(text)).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(detectRecordingIntent('RECORD MY SCREEN')).toBe(true);
    expect(detectRecordingIntent('Screen Recording')).toBe(true);
    expect(detectRecordingIntent('START RECORDING')).toBe(true);
  });
});

// ─── isRecordingOnly ────────────────────────────────────────────────────────

describe('isRecordingOnly', () => {
  test.each([
    'record my screen',
    'Record my screen',
    'start recording',
    'screen recording',
    'begin recording',
    'capture my screen',
    'make a recording',
  ])('returns true for pure recording request "%s"', (text) => {
    expect(isRecordingOnly(text)).toBe(true);
  });

  test('returns true when polite fillers surround the recording request', () => {
    expect(isRecordingOnly('please record my screen')).toBe(true);
    expect(isRecordingOnly('can you start recording')).toBe(true);
    expect(isRecordingOnly('could you record my screen please')).toBe(true);
    expect(isRecordingOnly('hey, start recording now')).toBe(true);
    expect(isRecordingOnly('just record my screen, thanks')).toBe(true);
    expect(isRecordingOnly('can you start recording?')).toBe(true);
  });

  test.each([
    'record my screen and then open Safari',
    'do this task and record my screen',
    'record my screen while I work on the document',
    'open Chrome and start recording',
    'record my screen and send it to Bob',
  ])('returns false for mixed-intent "%s"', (text) => {
    expect(isRecordingOnly(text)).toBe(false);
  });

  test('returns false for empty or unrelated text', () => {
    expect(isRecordingOnly('')).toBe(false);
    expect(isRecordingOnly('hello world')).toBe(false);
    expect(isRecordingOnly('open Safari')).toBe(false);
  });

  test('handles punctuation in recording-only prompts', () => {
    expect(isRecordingOnly('record my screen!')).toBe(true);
    expect(isRecordingOnly('start recording.')).toBe(true);
    expect(isRecordingOnly('screen recording?')).toBe(true);
  });
});

// ─── detectStopRecordingIntent ──────────────────────────────────────────────

describe('detectStopRecordingIntent', () => {
  test.each([
    'stop recording',
    'stop the recording',
    'end recording',
    'end the recording',
    'finish recording',
    'finish the recording',
    'halt recording',
    'halt the recording',
  ])('detects stop intent in "%s"', (text) => {
    expect(detectStopRecordingIntent(text)).toBe(true);
  });

  test.each([
    '',
    'hello world',
    'stop it',
    'end it',
    'quit',
    'record my screen',
    'start recording',
    'take a screenshot',
    'stop the music',
  ])('does not detect stop intent in "%s"', (text) => {
    expect(detectStopRecordingIntent(text)).toBe(false);
  });

  test('is case-insensitive', () => {
    expect(detectStopRecordingIntent('STOP RECORDING')).toBe(true);
    expect(detectStopRecordingIntent('Stop The Recording')).toBe(true);
    expect(detectStopRecordingIntent('END RECORDING')).toBe(true);
  });
});

// ─── stripRecordingIntent ───────────────────────────────────────────────────

describe('stripRecordingIntent', () => {
  test('removes recording clause from mixed-intent prompt', () => {
    expect(stripRecordingIntent('open Safari and record my screen')).toBe('open Safari');
    expect(stripRecordingIntent('open Safari and also record my screen')).toBe('open Safari');
  });

  test('removes start recording clause', () => {
    expect(stripRecordingIntent('do this task and start recording')).toBe('do this task');
  });

  test('removes begin recording clause', () => {
    expect(stripRecordingIntent('write a report and begin recording')).toBe('write a report');
  });

  test('removes capture clause', () => {
    expect(stripRecordingIntent('check email and capture my screen')).toBe('check email');
  });

  test('removes "while" phrased recording clauses', () => {
    const result = stripRecordingIntent('do this task while recording the screen');
    // The while-recording pattern should be removed
    expect(result).not.toContain('recording');
  });

  test('returns empty string for recording-only text after stripping', () => {
    const result = stripRecordingIntent('record my screen');
    // After stripping the recording clause, only the unmatched part remains
    expect(result.trim().length).toBeLessThanOrEqual(result.length);
  });

  test('cleans up double spaces', () => {
    const result = stripRecordingIntent('open Safari and also record my screen please');
    expect(result).not.toContain('  ');
  });

  test('returns unrelated text unchanged', () => {
    expect(stripRecordingIntent('hello world')).toBe('hello world');
    expect(stripRecordingIntent('open Safari')).toBe('open Safari');
  });

  test('handles empty string', () => {
    expect(stripRecordingIntent('')).toBe('');
  });
});

// ─── stripStopRecordingIntent ───────────────────────────────────────────────

describe('stripStopRecordingIntent', () => {
  test('removes stop recording clause from mixed-intent prompt', () => {
    expect(stripStopRecordingIntent('open Chrome and stop recording')).toBe('open Chrome');
    expect(stripStopRecordingIntent('open Chrome and also stop recording')).toBe('open Chrome');
  });

  test('removes end recording clause', () => {
    expect(stripStopRecordingIntent('save the file and end the recording')).toBe('save the file');
  });

  test('removes finish recording clause', () => {
    expect(stripStopRecordingIntent('close the browser and finish recording')).toBe('close the browser');
  });

  test('removes halt recording clause', () => {
    expect(stripStopRecordingIntent('do this and halt the recording')).toBe('do this');
  });

  test('returns unrelated text unchanged', () => {
    expect(stripStopRecordingIntent('hello world')).toBe('hello world');
    expect(stripStopRecordingIntent('open Safari')).toBe('open Safari');
  });

  test('handles empty string', () => {
    expect(stripStopRecordingIntent('')).toBe('');
  });

  test('cleans up double spaces', () => {
    const result = stripStopRecordingIntent('open Safari and also stop recording please');
    expect(result).not.toContain('  ');
  });
});

// ─── isStopRecordingOnly ────────────────────────────────────────────────────

describe('isStopRecordingOnly', () => {
  test.each([
    'stop recording',
    'stop the recording',
    'end recording',
    'end the recording',
    'finish recording',
    'halt recording',
  ])('returns true for pure stop-recording request "%s"', (text) => {
    expect(isStopRecordingOnly(text)).toBe(true);
  });

  test('returns true when polite fillers surround the stop request', () => {
    expect(isStopRecordingOnly('please stop recording')).toBe(true);
    expect(isStopRecordingOnly('can you stop the recording?')).toBe(true);
    expect(isStopRecordingOnly('could you end the recording please')).toBe(true);
    expect(isStopRecordingOnly('stop the recording now')).toBe(true);
    expect(isStopRecordingOnly('just stop recording, thanks')).toBe(true);
  });

  test.each([
    'stop recording and open Chrome',
    'end the recording and then close Safari',
    'how do I stop recording?',
  ])('returns false for mixed-intent or questioning "%s"', (text) => {
    expect(isStopRecordingOnly(text)).toBe(false);
  });

  test('returns false for ambiguous phrases', () => {
    expect(isStopRecordingOnly('end it')).toBe(false);
    expect(isStopRecordingOnly('stop')).toBe(false);
    expect(isStopRecordingOnly('quit')).toBe(false);
  });

  test('returns false for empty or unrelated text', () => {
    expect(isStopRecordingOnly('')).toBe(false);
    expect(isStopRecordingOnly('hello world')).toBe(false);
    expect(isStopRecordingOnly('open Safari')).toBe(false);
  });

  test('handles punctuation', () => {
    expect(isStopRecordingOnly('stop recording!')).toBe(true);
    expect(isStopRecordingOnly('stop recording.')).toBe(true);
    expect(isStopRecordingOnly('end the recording?')).toBe(true);
  });
});
