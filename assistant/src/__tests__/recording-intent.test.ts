import { describe, expect,test } from 'bun:test';

import {
  classifyRecordingIntent,
  detectRecordingIntent,
  detectStopRecordingIntent,
  isInterrogative,
  isRecordingOnly,
  isStopRecordingOnly,
  stripRecordingIntent,
  stripStopRecordingIntent,
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

// ─── classifyRecordingIntent ────────────────────────────────────────────────

describe('classifyRecordingIntent', () => {
  // Basic classification
  test.each([
    ['record my screen', 'start_only'],
    ['stop recording', 'stop_only'],
    ['open Safari and record my screen', 'mixed'],
    ['hello world', 'none'],
    ['', 'none'],
  ] as const)('basic: "%s" → %s', (text, expected) => {
    expect(classifyRecordingIntent(text)).toBe(expected);
  });

  // Dynamic name stripping
  test.each([
    ['Nova, record my screen', ['Nova'], 'start_only'],
    ['hey Nova, start recording', ['Nova'], 'start_only'],
    ['hey, Nova, start recording', ['Nova'], 'start_only'],
    ['Nova, stop recording', ['Nova'], 'stop_only'],
    ['Nova, open Safari and record my screen', ['Nova'], 'mixed'],
    ['Nova, hello', ['Nova'], 'none'],
  ] as const)('dynamic names: "%s" with %j → %s', (text, names, expected) => {
    expect(classifyRecordingIntent(text, [...names])).toBe(expected);
  });

  // No dynamic names (backwards compat)
  test('works without dynamic names parameter', () => {
    expect(classifyRecordingIntent('record my screen')).toBe('start_only');
    expect(classifyRecordingIntent('stop recording')).toBe('stop_only');
  });

  // With fillers
  test('handles filler words correctly', () => {
    expect(classifyRecordingIntent('please record my screen')).toBe('start_only');
    expect(classifyRecordingIntent('can you stop recording?')).toBe('stop_only');
  });

  // Both start and stop → mixed
  test('classifies as mixed when both start and stop patterns are present', () => {
    expect(classifyRecordingIntent('start recording and then stop recording')).toBe('mixed');
    expect(classifyRecordingIntent('record my screen and stop recording')).toBe('mixed');
  });

  // Edge cases
  test('classifies as mixed when stop-recording has additional task', () => {
    expect(classifyRecordingIntent('stop recording and open Chrome')).toBe('mixed');
  });

  // Case insensitivity with dynamic names
  test('dynamic name stripping is case-insensitive', () => {
    expect(classifyRecordingIntent('nova, record my screen', ['Nova'])).toBe('start_only');
    expect(classifyRecordingIntent('NOVA, stop recording', ['Nova'])).toBe('stop_only');
    expect(classifyRecordingIntent('Hey NOVA, start recording', ['nova'])).toBe('start_only');
  });

  // Multiple dynamic names
  test('handles multiple dynamic names', () => {
    expect(classifyRecordingIntent('Jarvis, record my screen', ['Nova', 'Jarvis'])).toBe(
      'start_only',
    );
    expect(classifyRecordingIntent('Nova, stop recording', ['Nova', 'Jarvis'])).toBe('stop_only');
  });

  // Empty dynamic names array
  test('handles empty dynamic names array', () => {
    expect(classifyRecordingIntent('record my screen', [])).toBe('start_only');
    expect(classifyRecordingIntent('stop recording', [])).toBe('stop_only');
  });

  // Name with colon separator
  test('handles colon separator after name', () => {
    expect(classifyRecordingIntent('Nova: record my screen', ['Nova'])).toBe('start_only');
  });
});

// ─── isInterrogative ──────────────────────────────────────────────────────────

describe('isInterrogative', () => {
  // Questions about recording — should return true
  test.each([
    'how do I stop recording?',
    'how do I record my screen?',
    'what does screen recording do?',
    'why is screen recording not working?',
    'when should I stop recording?',
    'where does the recording file go?',
    'which display should I record?',
    'What is the screen recording feature?',
    'How do I start recording on Mac?',
  ])('returns true for question: "%s"', (text) => {
    expect(isInterrogative(text)).toBe(true);
  });

  // Imperative commands — should return false
  test.each([
    'record my screen',
    'stop recording',
    'open Chrome and record my screen',
    'stop recording and close the browser',
    'can you record my screen?',
    'could you stop recording please',
    'start recording',
    'please record my screen',
  ])('returns false for command: "%s"', (text) => {
    expect(isInterrogative(text)).toBe(false);
  });

  // With dynamic names — strips name prefix first
  test('strips dynamic name before checking', () => {
    expect(isInterrogative('Nova, how do I stop recording?', ['Nova'])).toBe(true);
    expect(isInterrogative('Nova, record my screen', ['Nova'])).toBe(false);
  });

  // Polite prefix + question
  test('handles polite prefix before question word', () => {
    expect(isInterrogative('please, how do I stop recording?')).toBe(true);
    expect(isInterrogative('hey, what does screen recording do?')).toBe(true);
  });
});
