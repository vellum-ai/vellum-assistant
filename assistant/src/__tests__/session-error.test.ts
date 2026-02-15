import { describe, expect, it } from 'bun:test';
import {
  classifySessionError,
  isUserCancellation,
  buildSessionErrorMessage,
} from '../daemon/session-error.js';
import type { ErrorContext } from '../daemon/session-error.js';

describe('isUserCancellation', () => {
  it('returns false for non-AbortError even when abort flag is set', () => {
    const ctx: ErrorContext = { phase: 'agent_loop', aborted: true };
    expect(isUserCancellation(new Error('something'), ctx)).toBe(false);
  });

  it('returns false for non-AbortError network failure during abort', () => {
    const ctx: ErrorContext = { phase: 'agent_loop', aborted: true };
    expect(isUserCancellation(new Error('ECONNREFUSED'), ctx)).toBe(false);
  });

  it('returns true for AbortError (DOMException-style) when aborted', () => {
    const err = new DOMException('The operation was aborted', 'AbortError');
    const ctx: ErrorContext = { phase: 'agent_loop', aborted: true };
    expect(isUserCancellation(err, ctx)).toBe(true);
  });

  it('returns true for AbortError (Error with name set) when aborted', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const ctx: ErrorContext = { phase: 'agent_loop', aborted: true };
    expect(isUserCancellation(err, ctx)).toBe(true);
  });

  it('returns false for AbortError (DOMException-style) when NOT aborted', () => {
    const err = new DOMException('The operation was aborted', 'AbortError');
    const ctx: ErrorContext = { phase: 'agent_loop', aborted: false };
    expect(isUserCancellation(err, ctx)).toBe(false);
  });

  it('returns false for AbortError (Error with name set) when NOT aborted', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const ctx: ErrorContext = { phase: 'agent_loop', aborted: false };
    expect(isUserCancellation(err, ctx)).toBe(false);
  });

  it('returns false for non-abort errors without abort flag', () => {
    const ctx: ErrorContext = { phase: 'agent_loop', aborted: false };
    expect(isUserCancellation(new Error('network timeout'), ctx)).toBe(false);
  });

  it('returns false for non-Error values without abort flag', () => {
    const ctx: ErrorContext = { phase: 'agent_loop', aborted: false };
    expect(isUserCancellation('some string error', ctx)).toBe(false);
  });
});

describe('classifySessionError', () => {
  const baseCtx: ErrorContext = { phase: 'agent_loop' };

  describe('network errors', () => {
    const cases = [
      'ECONNREFUSED',
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'socket hang up',
      'fetch failed',
      'Connection refused by server',
      'connection reset',
      'connection timeout',
    ];

    for (const msg of cases) {
      it(`classifies "${msg}" as PROVIDER_NETWORK`, () => {
        const result = classifySessionError(new Error(msg), baseCtx);
        expect(result.code).toBe('PROVIDER_NETWORK');
        expect(result.retryable).toBe(true);
      });
    }
  });

  describe('rate limit errors', () => {
    const cases = [
      'Error 429: Too many requests',
      'rate limit exceeded',
      'Rate-limit hit',
      'too many requests',
      'overloaded',
    ];

    for (const msg of cases) {
      it(`classifies "${msg}" as PROVIDER_RATE_LIMIT`, () => {
        const result = classifySessionError(new Error(msg), baseCtx);
        expect(result.code).toBe('PROVIDER_RATE_LIMIT');
        expect(result.retryable).toBe(true);
      });
    }
  });

  describe('provider API errors', () => {
    const cases = [
      'HTTP 500 Internal Server Error',
      'server error',
      'Bad gateway',
      'Service unavailable',
      'Gateway timeout',
      '502 Bad Gateway',
    ];

    for (const msg of cases) {
      it(`classifies "${msg}" as PROVIDER_API`, () => {
        const result = classifySessionError(new Error(msg), baseCtx);
        expect(result.code).toBe('PROVIDER_API');
        expect(result.retryable).toBe(true);
      });
    }
  });

  describe('abort/cancel errors (non-user-initiated)', () => {
    it('classifies "aborted" as SESSION_ABORTED', () => {
      const result = classifySessionError(new Error('Request aborted'), baseCtx);
      expect(result.code).toBe('SESSION_ABORTED');
      expect(result.retryable).toBe(true);
    });

    it('classifies "cancelled" as SESSION_ABORTED', () => {
      const result = classifySessionError(new Error('Operation cancelled'), baseCtx);
      expect(result.code).toBe('SESSION_ABORTED');
      expect(result.retryable).toBe(true);
    });
  });

  describe('queue phase', () => {
    it('always returns QUEUE_FULL regardless of message content', () => {
      const ctx: ErrorContext = { phase: 'queue' };
      const result = classifySessionError(new Error('random error'), ctx);
      expect(result.code).toBe('QUEUE_FULL');
      expect(result.retryable).toBe(true);
    });
  });

  describe('regenerate phase', () => {
    it('returns REGENERATE_FAILED with nested classification info', () => {
      const ctx: ErrorContext = { phase: 'regenerate' };
      const result = classifySessionError(new Error('ECONNREFUSED'), ctx);
      expect(result.code).toBe('REGENERATE_FAILED');
      expect(result.retryable).toBe(true);
      expect(result.userMessage).toContain('regenerate');
    });

    it('returns REGENERATE_FAILED for generic errors', () => {
      const ctx: ErrorContext = { phase: 'regenerate' };
      const result = classifySessionError(new Error('unknown issue'), ctx);
      expect(result.code).toBe('REGENERATE_FAILED');
      expect(result.retryable).toBe(true);
    });
  });

  describe('generic errors', () => {
    it('classifies unknown errors as SESSION_PROCESSING_FAILED', () => {
      const result = classifySessionError(new Error('something completely unexpected'), baseCtx);
      expect(result.code).toBe('SESSION_PROCESSING_FAILED');
      expect(result.retryable).toBe(false);
    });

    it('includes debugDetails with stack trace', () => {
      const err = new Error('test error');
      const result = classifySessionError(err, baseCtx);
      expect(result.debugDetails).toBeDefined();
      expect(result.debugDetails).toContain('test error');
    });

    it('handles non-Error values', () => {
      const result = classifySessionError('plain string error', baseCtx);
      expect(result.code).toBe('SESSION_PROCESSING_FAILED');
      expect(result.debugDetails).toBe('plain string error');
    });
  });

  describe('cancel/abort should NOT produce false-positive session errors', () => {
    it('user-initiated cancel requires both AbortError and active abort signal', () => {
      const abortErr = new DOMException('The operation was aborted', 'AbortError');
      const abortCtx: ErrorContext = { phase: 'agent_loop', aborted: true };
      expect(isUserCancellation(abortErr, abortCtx)).toBe(true);

      // Non-AbortError during abort should NOT be treated as user cancellation
      expect(isUserCancellation(new Error('ECONNRESET'), abortCtx)).toBe(false);
    });

    it('DOMException AbortError is only caught when abort signal is active', () => {
      const err = new DOMException('The operation was aborted', 'AbortError');
      const notAborted: ErrorContext = { phase: 'agent_loop', aborted: false };
      expect(isUserCancellation(err, notAborted)).toBe(false);

      const aborted: ErrorContext = { phase: 'agent_loop', aborted: true };
      expect(isUserCancellation(err, aborted)).toBe(true);
    });
  });
});

describe('buildSessionErrorMessage', () => {
  it('builds a valid SessionErrorMessage', () => {
    const msg = buildSessionErrorMessage('session-123', {
      code: 'PROVIDER_NETWORK',
      userMessage: 'Network error',
      retryable: true,
      debugDetails: 'ECONNREFUSED',
    });

    expect(msg.type).toBe('session_error');
    expect(msg.sessionId).toBe('session-123');
    expect(msg.code).toBe('PROVIDER_NETWORK');
    expect(msg.userMessage).toBe('Network error');
    expect(msg.retryable).toBe(true);
    expect(msg.debugDetails).toBe('ECONNREFUSED');
  });

  it('omits debugDetails when not provided', () => {
    const msg = buildSessionErrorMessage('session-456', {
      code: 'UNKNOWN',
      userMessage: 'Something went wrong',
      retryable: false,
    });

    expect(msg.type).toBe('session_error');
    expect(msg.debugDetails).toBeUndefined();
  });
});
