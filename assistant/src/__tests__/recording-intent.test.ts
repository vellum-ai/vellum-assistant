import { beforeEach,describe, expect, mock, test } from 'bun:test';

import {
  resolveRecordingIntent,
} from '../daemon/recording-intent.js';

// ─── resolveRecordingIntent ─────────────────────────────────────────────────

describe('resolveRecordingIntent', () => {
  // ── Start detection (covers legacy detectRecordingIntent behavior) ───────

  describe('start intent detection', () => {
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
    ])('detects start intent in "%s"', (text) => {
      const result = resolveRecordingIntent(text);
      expect(result.kind).toBe('start_only');
    });

    // "make a screen recording" is detected as recording intent but resolves
    // to start_with_remainder because the strip patterns match "screen recording"
    // first, leaving "make a" as residual text.
    test('detects start intent in "make a screen recording" (with residual remainder)', () => {
      const result = resolveRecordingIntent('make a screen recording');
      expect(result.kind).toBe('start_with_remainder');
    });

    test.each([
      '',
      'hello world',
      'open Safari',
      'take a screenshot',
      'what time is it?',
      'record a note',
      'make a note',
      'start the timer',
    ])('does not detect start intent in "%s"', (text) => {
      expect(resolveRecordingIntent(text)).toEqual({ kind: 'none' });
    });

    test('is case-insensitive', () => {
      expect(resolveRecordingIntent('RECORD MY SCREEN').kind).toBe('start_only');
      expect(resolveRecordingIntent('Screen Recording').kind).toBe('start_only');
      expect(resolveRecordingIntent('START RECORDING').kind).toBe('start_only');
    });
  });

  // ── Pure start (covers legacy isRecordingOnly behavior) ─────────────────

  describe('pure start (recording-only)', () => {
    test.each([
      'record my screen',
      'Record my screen',
      'start recording',
      'screen recording',
      'begin recording',
      'capture my screen',
      'make a recording',
    ])('resolves as start_only for pure recording request "%s"', (text) => {
      expect(resolveRecordingIntent(text)).toEqual({ kind: 'start_only' });
    });

    test('resolves as start_only when polite fillers surround the recording request', () => {
      expect(resolveRecordingIntent('please record my screen')).toEqual({ kind: 'start_only' });
      expect(resolveRecordingIntent('can you start recording')).toEqual({ kind: 'start_only' });
      expect(resolveRecordingIntent('could you record my screen please')).toEqual({ kind: 'start_only' });
      expect(resolveRecordingIntent('hey, start recording now')).toEqual({ kind: 'start_only' });
      expect(resolveRecordingIntent('just record my screen, thanks')).toEqual({ kind: 'start_only' });
      expect(resolveRecordingIntent('can you start recording?')).toEqual({ kind: 'start_only' });
    });

    test.each([
      'record my screen and then open Safari',
      'do this task and record my screen',
      'record my screen while I work on the document',
      'open Chrome and start recording',
      'record my screen and send it to Bob',
    ])('resolves as start_with_remainder for mixed-intent "%s"', (text) => {
      expect(resolveRecordingIntent(text).kind).toBe('start_with_remainder');
    });

    test('handles punctuation in recording-only prompts', () => {
      expect(resolveRecordingIntent('record my screen!')).toEqual({ kind: 'start_only' });
      expect(resolveRecordingIntent('start recording.')).toEqual({ kind: 'start_only' });
      expect(resolveRecordingIntent('screen recording?')).toEqual({ kind: 'start_only' });
    });
  });

  // ── Stop detection (covers legacy detectStopRecordingIntent behavior) ───

  describe('stop intent detection', () => {
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
      expect(resolveRecordingIntent(text).kind).toBe('stop_only');
    });

    test.each([
      '',
      'hello world',
      'stop it',
      'end it',
      'quit',
      'take a screenshot',
      'stop the music',
    ])('does not detect stop intent in "%s"', (text) => {
      expect(resolveRecordingIntent(text)).toEqual({ kind: 'none' });
    });

    test('is case-insensitive', () => {
      expect(resolveRecordingIntent('STOP RECORDING').kind).toBe('stop_only');
      expect(resolveRecordingIntent('Stop The Recording').kind).toBe('stop_only');
      expect(resolveRecordingIntent('END RECORDING').kind).toBe('stop_only');
    });
  });

  // ── Pure stop (covers legacy isStopRecordingOnly behavior) ──────────────

  describe('pure stop (stop-recording-only)', () => {
    test.each([
      'stop recording',
      'stop the recording',
      'end recording',
      'end the recording',
      'finish recording',
      'halt recording',
    ])('resolves as stop_only for pure stop request "%s"', (text) => {
      expect(resolveRecordingIntent(text)).toEqual({ kind: 'stop_only' });
    });

    test('resolves as stop_only when polite fillers surround the stop request', () => {
      expect(resolveRecordingIntent('please stop recording')).toEqual({ kind: 'stop_only' });
      expect(resolveRecordingIntent('can you stop the recording?')).toEqual({ kind: 'stop_only' });
      expect(resolveRecordingIntent('could you end the recording please')).toEqual({ kind: 'stop_only' });
      expect(resolveRecordingIntent('stop the recording now')).toEqual({ kind: 'stop_only' });
      expect(resolveRecordingIntent('just stop recording, thanks')).toEqual({ kind: 'stop_only' });
    });

    test('resolves as stop_with_remainder when stop has additional task', () => {
      const r1 = resolveRecordingIntent('stop recording and open Chrome');
      expect(r1.kind).toBe('stop_with_remainder');
      if (r1.kind === 'stop_with_remainder') {
        expect(r1.remainder).toContain('open Chrome');
      }
    });

    test('handles ambiguous phrases as none', () => {
      expect(resolveRecordingIntent('end it')).toEqual({ kind: 'none' });
      expect(resolveRecordingIntent('stop')).toEqual({ kind: 'none' });
      expect(resolveRecordingIntent('quit')).toEqual({ kind: 'none' });
    });

    test('handles punctuation', () => {
      expect(resolveRecordingIntent('stop recording!')).toEqual({ kind: 'stop_only' });
      expect(resolveRecordingIntent('stop recording.')).toEqual({ kind: 'stop_only' });
      expect(resolveRecordingIntent('end the recording?')).toEqual({ kind: 'stop_only' });
    });
  });

  // ── Remainder extraction (covers legacy strip* behavior) ────────────────

  describe('remainder extraction', () => {
    test('extracts remainder when start intent is mixed with other task', () => {
      const r1 = resolveRecordingIntent('open Safari and record my screen');
      expect(r1.kind).toBe('start_with_remainder');
      if (r1.kind === 'start_with_remainder') {
        expect(r1.remainder).toBe('open Safari');
      }

      const r2 = resolveRecordingIntent('do this task and start recording');
      expect(r2.kind).toBe('start_with_remainder');
      if (r2.kind === 'start_with_remainder') {
        expect(r2.remainder).toContain('do this task');
      }
    });

    test('extracts remainder when stop intent is mixed with other task', () => {
      const r1 = resolveRecordingIntent('open Chrome and stop recording');
      expect(r1.kind).toBe('stop_with_remainder');
      if (r1.kind === 'stop_with_remainder') {
        expect(r1.remainder).toBe('open Chrome');
      }

      const r2 = resolveRecordingIntent('save the file and end the recording');
      expect(r2.kind).toBe('stop_with_remainder');
      if (r2.kind === 'stop_with_remainder') {
        expect(r2.remainder).toContain('save the file');
      }
    });

    test('remainder does not contain double spaces', () => {
      const r1 = resolveRecordingIntent('open Safari and also record my screen please');
      if (r1.kind === 'start_with_remainder') {
        expect(r1.remainder).not.toContain('  ');
      }

      const r2 = resolveRecordingIntent('open Safari and also stop recording please');
      if (r2.kind === 'stop_with_remainder') {
        expect(r2.remainder).not.toContain('  ');
      }
    });
  });

  // ── Interrogative gate (covers legacy isInterrogative behavior) ─────────

  describe('interrogative gate', () => {
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
      'how can I record my screen?',
      'why did the recording stop?',
    ])('returns none for question: "%s"', (text) => {
      expect(resolveRecordingIntent(text)).toEqual({ kind: 'none' });
    });

    test.each([
      'record my screen',
      'stop recording',
      'open Chrome and record my screen',
      'can you record my screen?',
      'could you stop recording please',
      'start recording',
      'please record my screen',
    ])('does not block command: "%s"', (text) => {
      expect(resolveRecordingIntent(text).kind).not.toBe('none');
    });

    test('strips dynamic name before checking interrogative', () => {
      expect(resolveRecordingIntent('Nova, how do I stop recording?', ['Nova'])).toEqual({ kind: 'none' });
      expect(resolveRecordingIntent('Nova, record my screen', ['Nova']).kind).toBe('start_only');
    });

    test('handles polite prefix before question word', () => {
      expect(resolveRecordingIntent('please, how do I stop recording?')).toEqual({ kind: 'none' });
      expect(resolveRecordingIntent('hey, what does screen recording do?')).toEqual({ kind: 'none' });
    });

    // Interrogative gate for new patterns
    test('returns none for question about restart', () => {
      expect(resolveRecordingIntent('how do I restart recording?')).toEqual({ kind: 'none' });
    });

    test('returns none for question about pause', () => {
      expect(resolveRecordingIntent('how can I pause recording?')).toEqual({ kind: 'none' });
    });

    test('returns none for question about resume', () => {
      expect(resolveRecordingIntent('how do I resume recording?')).toEqual({ kind: 'none' });
    });

    // ── Indirect informational patterns ───────────────────────────────────

    test.each([
      'can you tell me how to stop recording?',
      'could you tell me how to stop recording?',
      'would you tell me how to stop recording?',
      'explain how to stop the recording',
      'tell me how recording works',
      'describe how screen recording works',
      'show me how to record my screen',
      'is there a way to stop recording?',
      'is there a method to pause recording?',
      'are there any ways to record my screen?',
      "I'd like to know how to stop recording",
      "I would like to know how to pause the recording",
      'I want to know how to start recording',
      'do you know how to start recording?',
      'can I learn how to record my screen?',
      'can you explain how to record my screen?',
      'tell me about how screen recording works',
      'explain to me how to stop recording',
      'tell me what screen recording does',
      'describe how to start a recording',
      'please, tell me how to stop recording',
      'hey, can you explain how to record my screen?',
    ])('returns none for indirect informational question: "%s"', (text) => {
      expect(resolveRecordingIntent(text)).toEqual({ kind: 'none' });
    });

    test('indirect informational with dynamic name returns none', () => {
      expect(resolveRecordingIntent('Nova, can you tell me how to stop recording?', ['Nova'])).toEqual({ kind: 'none' });
      expect(resolveRecordingIntent('Nova, explain how to record my screen', ['Nova'])).toEqual({ kind: 'none' });
      expect(resolveRecordingIntent('hey Nova, is there a way to stop recording?', ['Nova'])).toEqual({ kind: 'none' });
    });

    // ── Polite imperatives that should still execute (NOT none) ──────────

    test.each([
      ['can you stop recording?', 'stop_only'],
      ['could you record my screen?', 'start_only'],
      ['can you pause the recording?', 'pause_only'],
      ['would you resume recording?', 'resume_only'],
      ['please stop recording', 'stop_only'],
      ['can you start recording?', 'start_only'],
      ['could you stop the recording please', 'stop_only'],
    ] as const)('polite imperative "%s" resolves to %s (not none)', (text, expected) => {
      expect(resolveRecordingIntent(text).kind).toBe(expected);
    });
  });

  // ── Mixed-intent with remainder (regression coverage) ────────────────────

  describe('mixed-intent with remainder', () => {
    test('"stop recording and start a new one and open safari" → restart_with_remainder', () => {
      const result = resolveRecordingIntent('stop recording and start a new one and open safari');
      expect(result.kind).toBe('restart_with_remainder');
      if (result.kind === 'restart_with_remainder') {
        expect(result.remainder).toContain('open safari');
      }
    });

    test('"record my screen and open Chrome and go to google.com" → start_with_remainder', () => {
      const result = resolveRecordingIntent('record my screen and open Chrome and go to google.com');
      expect(result.kind).toBe('start_with_remainder');
      if (result.kind === 'start_with_remainder') {
        expect(result.remainder).toContain('open Chrome');
        expect(result.remainder).toContain('google.com');
      }
    });

    test('"stop recording and send the file to Bob" → stop_with_remainder', () => {
      const result = resolveRecordingIntent('stop recording and send the file to Bob');
      expect(result.kind).toBe('stop_with_remainder');
      if (result.kind === 'stop_with_remainder') {
        expect(result.remainder).toContain('send the file to Bob');
      }
    });
  });

  // ── Dynamic names ──────────────────────────────────────────────────────────

  describe('dynamic name handling', () => {
    test.each([
      ['Nova, record my screen', ['Nova'], 'start_only'],
      ['hey Nova, start recording', ['Nova'], 'start_only'],
      ['hey, Nova, start recording', ['Nova'], 'start_only'],
      ['Nova, stop recording', ['Nova'], 'stop_only'],
      ['Nova, hello', ['Nova'], 'none'],
    ] as const)('"%s" with names %j resolves to %s', (text, names, expected) => {
      expect(resolveRecordingIntent(text, [...names]).kind).toBe(expected);
    });

    test('mixed intent with dynamic name extracts remainder', () => {
      const result = resolveRecordingIntent('Nova, open Safari and record my screen', ['Nova']);
      expect(result.kind).toBe('start_with_remainder');
      if (result.kind === 'start_with_remainder') {
        expect(result.remainder).toContain('open Safari');
      }
    });

    test('dynamic name stripping is case-insensitive', () => {
      expect(resolveRecordingIntent('nova, record my screen', ['Nova']).kind).toBe('start_only');
      expect(resolveRecordingIntent('NOVA, stop recording', ['Nova']).kind).toBe('stop_only');
      expect(resolveRecordingIntent('Hey NOVA, start recording', ['nova']).kind).toBe('start_only');
    });

    test('handles multiple dynamic names', () => {
      expect(resolveRecordingIntent('Jarvis, record my screen', ['Nova', 'Jarvis']).kind).toBe('start_only');
      expect(resolveRecordingIntent('Nova, stop recording', ['Nova', 'Jarvis']).kind).toBe('stop_only');
    });

    test('handles empty dynamic names array', () => {
      expect(resolveRecordingIntent('record my screen', []).kind).toBe('start_only');
      expect(resolveRecordingIntent('stop recording', []).kind).toBe('stop_only');
    });

    test('handles colon separator after name', () => {
      expect(resolveRecordingIntent('Nova: record my screen', ['Nova']).kind).toBe('start_only');
    });

    test('interrogative with name prefix returns none', () => {
      expect(resolveRecordingIntent('hey Nova, how do I stop recording?', ['Nova'])).toEqual({ kind: 'none' });
    });
  });

  // ── Start + stop combined ──────────────────────────────────────────────────

  describe('combined start and stop', () => {
    test('start and stop: "stop recording and record my screen"', () => {
      const result = resolveRecordingIntent('stop recording and record my screen');
      expect(result.kind).toBe('start_and_stop_only');
    });

    test('start and stop: "stop recording and start recording"', () => {
      const result = resolveRecordingIntent('stop recording and start recording');
      expect(result.kind).toBe('start_and_stop_only');
    });
  });

  // ── Restart compound detection ────────────────────────────────────────────

  describe('restart compound detection', () => {
    test('"restart the recording" → restart_only', () => {
      expect(resolveRecordingIntent('restart the recording')).toEqual({ kind: 'restart_only' });
    });

    test('"restart recording" → restart_only', () => {
      expect(resolveRecordingIntent('restart recording')).toEqual({ kind: 'restart_only' });
    });

    test('"redo the recording" → restart_only', () => {
      expect(resolveRecordingIntent('redo the recording')).toEqual({ kind: 'restart_only' });
    });

    test('"stop recording and start a new one" → restart_only', () => {
      expect(resolveRecordingIntent('stop recording and start a new one')).toEqual({ kind: 'restart_only' });
    });

    test('"stop the recording and start a new one" → restart_only', () => {
      expect(resolveRecordingIntent('stop the recording and start a new one')).toEqual({ kind: 'restart_only' });
    });

    test('"stop the recording and begin a fresh" → restart_only', () => {
      expect(resolveRecordingIntent('stop the recording and begin a fresh')).toEqual({ kind: 'restart_only' });
    });

    test('"stop and restart the recording" → restart_only', () => {
      expect(resolveRecordingIntent('stop and restart the recording')).toEqual({ kind: 'restart_only' });
    });

    test('"stop recording and start a new" → restart_only', () => {
      expect(resolveRecordingIntent('stop recording and start a new')).toEqual({ kind: 'restart_only' });
    });

    test('"stop recording and start another" → restart_only', () => {
      expect(resolveRecordingIntent('stop recording and start another')).toEqual({ kind: 'restart_only' });
    });

    test('"stop recording and start another." → restart_only (trailing period)', () => {
      expect(resolveRecordingIntent('stop recording and start another.')).toEqual({ kind: 'restart_only' });
    });

    test('"stop recording and start a new!" → restart_only (trailing exclamation)', () => {
      expect(resolveRecordingIntent('stop recording and start a new!')).toEqual({ kind: 'restart_only' });
    });

    test('restart with remainder: "restart recording and open safari"', () => {
      const result = resolveRecordingIntent('restart recording and open safari');
      expect(result.kind).toBe('restart_with_remainder');
      if (result.kind === 'restart_with_remainder') {
        expect(result.remainder).toContain('open safari');
      }
    });

    test('restart with polite fillers resolves as restart_only', () => {
      expect(resolveRecordingIntent('please restart the recording')).toEqual({ kind: 'restart_only' });
      expect(resolveRecordingIntent('can you restart recording')).toEqual({ kind: 'restart_only' });
    });

    test('restart takes precedence over independent start/stop', () => {
      // "stop recording and start a new one" should be restart, not start_and_stop
      const result = resolveRecordingIntent('stop recording and start a new one');
      expect(result.kind).toBe('restart_only');
    });

    test('"stop recording and start a new recording" → restart_only', () => {
      expect(resolveRecordingIntent('stop recording and start a new recording')).toEqual({ kind: 'restart_only' });
    });

    test('"stop the recording and start another recording" → restart_only', () => {
      expect(resolveRecordingIntent('stop the recording and start another recording')).toEqual({ kind: 'restart_only' });
    });

    // False positive guards: "start another/new <non-recording>" should NOT trigger restart
    test('"stop recording and start another tab" should NOT trigger restart', () => {
      const result = resolveRecordingIntent('stop recording and start another tab');
      expect(result.kind).toBe('stop_with_remainder');
    });

    test('"stop recording and start another window" should NOT trigger restart', () => {
      const result = resolveRecordingIntent('stop recording and start another window');
      expect(result.kind).toBe('stop_with_remainder');
    });

    test('"stop recording and start a new project" should NOT trigger restart', () => {
      const result = resolveRecordingIntent('stop recording and start a new project');
      expect(result.kind).toBe('stop_with_remainder');
    });

    test('"stop the recording and begin a fresh session" should NOT trigger restart', () => {
      const result = resolveRecordingIntent('stop the recording and begin a fresh session');
      expect(result.kind).toBe('stop_with_remainder');
    });
  });

  // ── Pause detection ───────────────────────────────────────────────────────

  describe('pause detection', () => {
    test('"pause recording" → pause_only', () => {
      expect(resolveRecordingIntent('pause recording')).toEqual({ kind: 'pause_only' });
    });

    test('"pause the recording" → pause_only', () => {
      expect(resolveRecordingIntent('pause the recording')).toEqual({ kind: 'pause_only' });
    });

    test('pause with polite fillers resolves as pause_only', () => {
      expect(resolveRecordingIntent('please pause the recording')).toEqual({ kind: 'pause_only' });
      expect(resolveRecordingIntent('can you pause recording')).toEqual({ kind: 'pause_only' });
    });
  });

  // ── Resume detection ──────────────────────────────────────────────────────

  describe('resume detection', () => {
    test('"resume recording" → resume_only', () => {
      expect(resolveRecordingIntent('resume recording')).toEqual({ kind: 'resume_only' });
    });

    test('"resume the recording" → resume_only', () => {
      expect(resolveRecordingIntent('resume the recording')).toEqual({ kind: 'resume_only' });
    });

    test('"unpause the recording" → resume_only', () => {
      expect(resolveRecordingIntent('unpause the recording')).toEqual({ kind: 'resume_only' });
    });

    test('resume with polite fillers resolves as resume_only', () => {
      expect(resolveRecordingIntent('please resume the recording')).toEqual({ kind: 'resume_only' });
    });
  });

  // ── False positive guards ─────────────────────────────────────────────────

  describe('false positive guards', () => {
    test('"I recorded a restart" → none', () => {
      expect(resolveRecordingIntent('I recorded a restart')).toEqual({ kind: 'none' });
    });

    test('"the pause button is broken" → none (no recording mention)', () => {
      expect(resolveRecordingIntent('the pause button is broken')).toEqual({ kind: 'none' });
    });

    test('"resume my work" → none (no recording mention)', () => {
      expect(resolveRecordingIntent('resume my work')).toEqual({ kind: 'none' });
    });
  });

  // ── No recording intent ────────────────────────────────────────────────────

  describe('no recording intent', () => {
    test.each([
      'open Safari',
      'I broke the record',
      '',
      'hello world',
    ])('returns none for "%s"', (text) => {
      expect(resolveRecordingIntent(text)).toEqual({ kind: 'none' });
    });
  });

  // ── Works without dynamic names parameter ──────────────────────────────────

  test('works without dynamic names parameter', () => {
    expect(resolveRecordingIntent('record my screen')).toEqual({ kind: 'start_only' });
    expect(resolveRecordingIntent('stop recording')).toEqual({ kind: 'stop_only' });
  });
});

// ─── executeRecordingIntent ─────────────────────────────────────────────────

describe('executeRecordingIntent', () => {
  // Mock the recording handlers module
  const mockHandleRecordingStart = mock((): string | null => 'mock-recording-id');
  const mockHandleRecordingStop = mock((): string | undefined => 'mock-recording-id');
  const mockHandleRecordingRestart = mock((): { initiated: boolean; operationToken?: string; responseText: string } => ({
    initiated: true,
    operationToken: 'mock-token',
    responseText: 'Restarting screen recording.',
  }));
  const mockHandleRecordingPause = mock((): string | undefined => 'mock-recording-id');
  const mockHandleRecordingResume = mock((): string | undefined => 'mock-recording-id');

  mock.module('../daemon/handlers/recording.js', () => ({
    handleRecordingStart: mockHandleRecordingStart,
    handleRecordingStop: mockHandleRecordingStop,
    handleRecordingRestart: mockHandleRecordingRestart,
    handleRecordingPause: mockHandleRecordingPause,
    handleRecordingResume: mockHandleRecordingResume,
    isRecordingIdle: () => true,
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
    mockHandleRecordingRestart.mockReset();
    mockHandleRecordingPause.mockReset();
    mockHandleRecordingResume.mockReset();
    // Default: start succeeds (returns recording ID)
    mockHandleRecordingStart.mockReturnValue('mock-recording-id');
    // Default: stop succeeds (returns recording ID)
    mockHandleRecordingStop.mockReturnValue('mock-recording-id');
    // Default: restart succeeds
    mockHandleRecordingRestart.mockReturnValue({
      initiated: true,
      operationToken: 'mock-token',
      responseText: 'Restarting screen recording.',
    });
    // Default: pause succeeds
    mockHandleRecordingPause.mockReturnValue('mock-recording-id');
    // Default: resume succeeds
    mockHandleRecordingResume.mockReturnValue('mock-recording-id');
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
      recordingStarted: true,
      responseText: 'Starting screen recording.',
    });
  });

  test('start_only when recording already active → returns handled with already-active text', () => {
    mockHandleRecordingStart.mockReturnValue(null);
    const result = executeRecordingIntent({ kind: 'start_only' }, mockContext);
    expect(mockHandleRecordingStart).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      handled: true,
      recordingStarted: false,
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

  test('start_and_stop_only → routes through handleRecordingRestart, returns handled', () => {
    const result = executeRecordingIntent({ kind: 'start_and_stop_only' }, mockContext);
    expect(mockHandleRecordingRestart).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      handled: true,
      recordingStarted: true,
      responseText: 'Stopping current recording and starting a new one.',
    });
  });

  test('start_and_stop_only when restart fails → returns handled with restart failure text', () => {
    mockHandleRecordingRestart.mockReturnValue({
      initiated: false,
      responseText: 'No active recording to restart.',
    });
    const result = executeRecordingIntent({ kind: 'start_and_stop_only' }, mockContext);
    expect(mockHandleRecordingRestart).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      handled: true,
      recordingStarted: false,
      responseText: 'No active recording to restart.',
    });
  });

  test('start_and_stop_with_remainder → returns not handled with remainder and pendingStart when idle', () => {
    const result = executeRecordingIntent(
      { kind: 'start_and_stop_with_remainder', remainder: 'open Safari' },
      mockContext,
    );
    expect(result).toEqual({
      handled: false,
      remainderText: 'open Safari',
      pendingStart: true,
    });
  });

  // ── New intent kinds ──────────────────────────────────────────────────────

  test('restart_only → returns handled with restart text', () => {
    const result = executeRecordingIntent({ kind: 'restart_only' }, mockContext);
    expect(result).toEqual({
      handled: true,
      responseText: 'Restarting screen recording.',
    });
  });

  test('restart_with_remainder → returns not handled with remainder and pendingRestart', () => {
    const result = executeRecordingIntent(
      { kind: 'restart_with_remainder', remainder: 'and open safari' },
      mockContext,
    );
    expect(result).toEqual({
      handled: false,
      remainderText: 'and open safari',
      pendingRestart: true,
    });
  });

  test('pause_only → returns handled with pause text', () => {
    const result = executeRecordingIntent({ kind: 'pause_only' }, mockContext);
    expect(result).toEqual({
      handled: true,
      responseText: 'Pausing the recording.',
    });
  });

  test('resume_only → returns handled with resume text', () => {
    const result = executeRecordingIntent({ kind: 'resume_only' }, mockContext);
    expect(result).toEqual({
      handled: true,
      responseText: 'Resuming the recording.',
    });
  });
});
