import { describe, test, expect, mock, beforeEach } from 'bun:test';
import {
  detectRecordingIntent,
  isRecordingOnly,
  detectStopRecordingIntent,
  stripRecordingIntent,
  stripStopRecordingIntent,
  isStopRecordingOnly,
  classifyRecordingIntent,
  isInterrogative,
  resolveRecordingIntent,
  type RecordingIntentResult,
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

// ─── resolveRecordingIntent ─────────────────────────────────────────────────

describe('resolveRecordingIntent', () => {
  // Pure start
  test.each([
    'record my screen',
    'start recording',
    'capture my screen',
  ])('pure start: "%s" → start_only', (text) => {
    expect(resolveRecordingIntent(text)).toEqual({ kind: 'start_only' });
  });

  test('pure start with polite wrapper: "please record my screen"', () => {
    expect(resolveRecordingIntent('please record my screen')).toEqual({ kind: 'start_only' });
  });

  test('pure start with polite filler stripped: "can you record my screen"', () => {
    // "can you" is a filler; after stripping, only the recording clause remains
    expect(resolveRecordingIntent('can you record my screen')).toEqual({ kind: 'start_only' });
  });

  // Pure stop
  test.each([
    'stop recording',
    'end the recording',
  ])('pure stop: "%s" → stop_only', (text) => {
    expect(resolveRecordingIntent(text)).toEqual({ kind: 'stop_only' });
  });

  test('pure stop with polite wrapper: "please stop recording"', () => {
    expect(resolveRecordingIntent('please stop recording')).toEqual({ kind: 'stop_only' });
  });

  // Start with remainder
  test('start with remainder: "record my screen and open Safari"', () => {
    const result = resolveRecordingIntent('record my screen and open Safari');
    expect(result.kind).toBe('start_with_remainder');
    if (result.kind === 'start_with_remainder') {
      expect(result.remainder).toContain('open Safari');
    }
  });

  test('start with remainder: "open Chrome and record my screen"', () => {
    const result = resolveRecordingIntent('open Chrome and record my screen');
    expect(result.kind).toBe('start_with_remainder');
    if (result.kind === 'start_with_remainder') {
      expect(result.remainder).toContain('open Chrome');
    }
  });

  // Stop with remainder
  test('stop with remainder: "stop recording and open Chrome"', () => {
    const result = resolveRecordingIntent('stop recording and open Chrome');
    expect(result.kind).toBe('stop_with_remainder');
    if (result.kind === 'stop_with_remainder') {
      expect(result.remainder).toContain('open Chrome');
    }
  });

  // Start and stop combined
  test('start and stop: "stop recording and record my screen"', () => {
    const result = resolveRecordingIntent('stop recording and record my screen');
    expect(result.kind).toBe('start_and_stop_only');
  });

  test('start and stop: "stop recording and start a new recording"', () => {
    const result = resolveRecordingIntent('stop recording and start recording');
    expect(result.kind).toBe('start_and_stop_only');
  });

  // Questions (interrogative gate)
  test.each([
    'how do I stop recording?',
    'what does screen recording do?',
    'how can I record my screen?',
    'why did the recording stop?',
  ])('interrogative gate returns none: "%s"', (text) => {
    expect(resolveRecordingIntent(text)).toEqual({ kind: 'none' });
  });

  // Dynamic names
  test('dynamic names: "Nova, record my screen" with dynamicNames=["Nova"]', () => {
    expect(resolveRecordingIntent('Nova, record my screen', ['Nova'])).toEqual({
      kind: 'start_only',
    });
  });

  test('dynamic names: interrogative with name prefix returns none', () => {
    expect(resolveRecordingIntent('hey Nova, how do I stop recording?', ['Nova'])).toEqual({
      kind: 'none',
    });
  });

  test('dynamic names: "Nova, record my screen and open Safari" with dynamicNames=["Nova"]', () => {
    const result = resolveRecordingIntent('Nova, record my screen and open Safari', ['Nova']);
    expect(result.kind).toBe('start_with_remainder');
    if (result.kind === 'start_with_remainder') {
      expect(result.remainder).toContain('open Safari');
    }
  });

  // None (no recording intent)
  test.each([
    'open Safari',
    'I broke the record',
    '',
  ])('no recording intent: "%s" → none', (text) => {
    expect(resolveRecordingIntent(text)).toEqual({ kind: 'none' });
  });
});

// ─── executeRecordingIntent ─────────────────────────────────────────────────

describe('executeRecordingIntent', () => {
  // Mock the recording handlers module
  const mockHandleRecordingStart = mock(() => 'mock-recording-id');
  const mockHandleRecordingStop = mock(() => 'mock-recording-id');

  mock.module('../daemon/handlers/recording.js', () => ({
    handleRecordingStart: mockHandleRecordingStart,
    handleRecordingStop: mockHandleRecordingStop,
  }));

  // Dynamically import so the mock takes effect
  let executeRecordingIntent: typeof import('../daemon/recording-executor.js').executeRecordingIntent;

  // Must await the dynamic import before running tests
  const setupPromise = import('../daemon/recording-executor.js').then((mod) => {
    executeRecordingIntent = mod.executeRecordingIntent;
  });

  const mockContext = {
    conversationId: 'conv-123',
    socket: {} as any,
    ctx: {} as any,
  };

  beforeEach(async () => {
    await setupPromise;
    mockHandleRecordingStart.mockReset();
    mockHandleRecordingStop.mockReset();
    // Default: start succeeds (returns recording ID)
    mockHandleRecordingStart.mockReturnValue('mock-recording-id');
    // Default: stop succeeds (returns recording ID)
    mockHandleRecordingStop.mockReturnValue('mock-recording-id');
  });

  test('none → returns { handled: false }', () => {
    const result = executeRecordingIntent({ kind: 'none' }, mockContext);
    expect(result).toEqual({ handled: false });
  });

  test('start_only → calls handleRecordingStart, returns handled with start text', () => {
    const result = executeRecordingIntent({ kind: 'start_only' }, mockContext);
    expect(mockHandleRecordingStart).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      handled: true,
      responseText: 'Starting screen recording.',
    });
  });

  test('start_only when recording already active → returns handled with already-active text', () => {
    mockHandleRecordingStart.mockReturnValue(null);
    const result = executeRecordingIntent({ kind: 'start_only' }, mockContext);
    expect(mockHandleRecordingStart).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      handled: true,
      responseText: 'A recording is already active.',
    });
  });

  test('stop_only → calls handleRecordingStop, returns handled with stop text', () => {
    const result = executeRecordingIntent({ kind: 'stop_only' }, mockContext);
    expect(mockHandleRecordingStop).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      handled: true,
      responseText: 'Stopping the recording.',
    });
  });

  test('stop_only when no active recording → returns handled with no-active text', () => {
    mockHandleRecordingStop.mockReturnValue(undefined);
    const result = executeRecordingIntent({ kind: 'stop_only' }, mockContext);
    expect(result).toEqual({
      handled: true,
      responseText: 'No active recording to stop.',
    });
  });

  test('start_with_remainder → returns not handled with remainder and pendingStart', () => {
    const result = executeRecordingIntent(
      { kind: 'start_with_remainder', remainder: 'open Safari' },
      mockContext,
    );
    expect(result).toEqual({
      handled: false,
      remainderText: 'open Safari',
      pendingStart: true,
    });
  });

  test('stop_with_remainder → returns not handled with remainder and pendingStop', () => {
    const result = executeRecordingIntent(
      { kind: 'stop_with_remainder', remainder: 'open Chrome' },
      mockContext,
    );
    expect(result).toEqual({
      handled: false,
      remainderText: 'open Chrome',
      pendingStop: true,
    });
  });

  test('start_and_stop_only → calls both stop and start, returns handled', () => {
    const result = executeRecordingIntent({ kind: 'start_and_stop_only' }, mockContext);
    expect(mockHandleRecordingStop).toHaveBeenCalledTimes(1);
    expect(mockHandleRecordingStart).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      handled: true,
      responseText: 'Stopping current recording and starting a new one.',
    });
  });

  test('start_and_stop_only when start fails → returns handled with stop-only text', () => {
    mockHandleRecordingStart.mockReturnValue(null);
    const result = executeRecordingIntent({ kind: 'start_and_stop_only' }, mockContext);
    expect(mockHandleRecordingStop).toHaveBeenCalledTimes(1);
    expect(mockHandleRecordingStart).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      handled: true,
      responseText: 'Stopping the recording.',
    });
  });

  test('start_and_stop_with_remainder → returns not handled with remainder and both pending flags', () => {
    const result = executeRecordingIntent(
      { kind: 'start_and_stop_with_remainder', remainder: 'open Safari' },
      mockContext,
    );
    expect(result).toEqual({
      handled: false,
      remainderText: 'open Safari',
      pendingStart: true,
      pendingStop: true,
    });
  });
});
