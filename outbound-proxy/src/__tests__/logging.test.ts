import { describe, expect, test } from 'bun:test';

import {
  buildDecisionTrace,
  createSafeLogEntry,
  type ProxyDecisionTrace,
  sanitizeHeaders,
  sanitizeUrl,
  stripQueryString,
} from '../logging.js';
import type { PolicyDecision } from '../types.js';

// ---------------------------------------------------------------------------
// sanitizeHeaders
// ---------------------------------------------------------------------------

describe('sanitizeHeaders', () => {
  test('redacts sensitive header values', () => {
    const headers = {
      Authorization: 'Bearer sk-secret',
      'Content-Type': 'application/json',
      'X-Api-Key': 'my-api-key',
    };
    const result = sanitizeHeaders(headers, ['Authorization', 'X-Api-Key']);
    expect(result).toEqual({
      Authorization: '[REDACTED]',
      'Content-Type': 'application/json',
      'X-Api-Key': '[REDACTED]',
    });
  });

  test('is case-insensitive for key matching', () => {
    const headers = {
      authorization: 'Bearer token',
      AUTHORIZATION: 'Bearer token2',
    };
    const result = sanitizeHeaders(headers, ['Authorization']);
    expect(result.authorization).toBe('[REDACTED]');
    expect(result.AUTHORIZATION).toBe('[REDACTED]');
  });

  test('preserves non-sensitive headers', () => {
    const headers = {
      'Content-Type': 'text/plain',
      Host: 'example.com',
    };
    const result = sanitizeHeaders(headers, ['Authorization']);
    expect(result).toEqual(headers);
  });

  test('handles empty sensitive keys list', () => {
    const headers = { Authorization: 'secret' };
    const result = sanitizeHeaders(headers, []);
    expect(result).toEqual(headers);
  });

  test('handles empty headers', () => {
    const result = sanitizeHeaders({}, ['Authorization']);
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// sanitizeUrl
// ---------------------------------------------------------------------------

describe('sanitizeUrl', () => {
  test('redacts sensitive query parameters', () => {
    const result = sanitizeUrl(
      'http://example.com/api?api_key=secret123&format=json',
      ['api_key'],
    );
    // URL.searchParams.set encodes brackets, so [REDACTED] becomes %5BREDACTED%5D
    expect(result).toContain('REDACTED');
    expect(result).not.toContain('secret123');
    expect(result).toContain('format=json');
  });

  test('returns URL unchanged when no sensitive params specified', () => {
    const url = 'http://example.com/api?key=value';
    expect(sanitizeUrl(url, [])).toBe(url);
  });

  test('handles relative paths with query parameters', () => {
    const result = sanitizeUrl('/api/v1?token=secret&page=1', ['token']);
    expect(result).not.toContain('secret');
    expect(result).toContain('page=1');
    // URL.searchParams.set encodes brackets
    expect(result).toContain('REDACTED');
  });

  test('returns URL unchanged when no query string present', () => {
    const url = 'http://example.com/api';
    expect(sanitizeUrl(url, ['api_key'])).toBe(url);
  });

  test('is case-insensitive for param matching', () => {
    const result = sanitizeUrl(
      'http://example.com/api?API_KEY=secret',
      ['api_key'],
    );
    expect(result).not.toContain('secret');
  });

  test('handles malformed URLs by stripping query string', () => {
    // A URL that can't be parsed
    const result = sanitizeUrl('://invalid?secret=value', ['secret']);
    expect(result).not.toContain('value');
  });
});

// ---------------------------------------------------------------------------
// createSafeLogEntry
// ---------------------------------------------------------------------------

describe('createSafeLogEntry', () => {
  test('sanitizes both headers and URL', () => {
    const entry = createSafeLogEntry(
      {
        method: 'GET',
        url: 'http://example.com/api?api_key=secret',
        headers: {
          Authorization: 'Bearer token',
          'Content-Type': 'application/json',
        },
      },
      ['Authorization', 'api_key'],
    );
    expect(entry.method).toBe('GET');
    expect(entry.url).not.toContain('secret');
    expect(entry.headers.Authorization).toBe('[REDACTED]');
    expect(entry.headers['Content-Type']).toBe('application/json');
  });
});

// ---------------------------------------------------------------------------
// stripQueryString
// ---------------------------------------------------------------------------

describe('stripQueryString', () => {
  test('strips query string from path', () => {
    expect(stripQueryString('/v1/run?api_key=secret')).toBe('/v1/run');
  });

  test('returns path unchanged when no query string', () => {
    expect(stripQueryString('/v1/models')).toBe('/v1/models');
  });

  test('handles empty query string', () => {
    expect(stripQueryString('/api?')).toBe('/api');
  });

  test('handles multiple question marks', () => {
    expect(stripQueryString('/api?a=1?b=2')).toBe('/api');
  });
});

// ---------------------------------------------------------------------------
// buildDecisionTrace
// ---------------------------------------------------------------------------

describe('buildDecisionTrace', () => {
  test('matched decision includes selected pattern and credential', () => {
    const decision: PolicyDecision = {
      kind: 'matched',
      credentialId: 'cred-fal',
      template: {
        hostPattern: '*.fal.ai',
        injectionType: 'header',
        headerName: 'Authorization',
        valuePrefix: 'Key ',
      },
    };
    const trace = buildDecisionTrace(
      'api.fal.ai',
      443,
      '/v1/run',
      'https',
      decision,
    );
    expect(trace).toEqual<ProxyDecisionTrace>({
      host: 'api.fal.ai',
      port: 443,
      path: '/v1/run',
      scheme: 'https',
      decisionKind: 'matched',
      candidateCount: 1,
      selectedPattern: '*.fal.ai',
      selectedCredentialId: 'cred-fal',
    });
  });

  test('ambiguous decision includes candidate count but no selection', () => {
    const decision: PolicyDecision = {
      kind: 'ambiguous',
      candidates: [
        {
          credentialId: 'cred-a',
          template: {
            hostPattern: '*.fal.ai',
            injectionType: 'header',
            headerName: 'Authorization',
          },
        },
        {
          credentialId: 'cred-b',
          template: {
            hostPattern: '*.fal.ai',
            injectionType: 'header',
            headerName: 'X-Key',
          },
        },
      ],
    };
    const trace = buildDecisionTrace(
      'api.fal.ai',
      null,
      '/',
      'https',
      decision,
    );
    expect(trace.decisionKind).toBe('ambiguous');
    expect(trace.candidateCount).toBe(2);
    expect(trace.selectedPattern).toBeNull();
    expect(trace.selectedCredentialId).toBeNull();
  });

  test('missing decision has zero candidates', () => {
    const decision: PolicyDecision = { kind: 'missing' };
    const trace = buildDecisionTrace(
      'unknown.com',
      443,
      '/',
      'https',
      decision,
    );
    expect(trace.decisionKind).toBe('missing');
    expect(trace.candidateCount).toBe(0);
    expect(trace.selectedPattern).toBeNull();
  });

  test('unauthenticated decision has zero candidates', () => {
    const decision: PolicyDecision = { kind: 'unauthenticated' };
    const trace = buildDecisionTrace(
      'example.com',
      null,
      '/',
      'http',
      decision,
    );
    expect(trace.decisionKind).toBe('unauthenticated');
    expect(trace.candidateCount).toBe(0);
  });

  test('ask_missing_credential includes matching pattern count', () => {
    const decision: PolicyDecision = {
      kind: 'ask_missing_credential',
      target: {
        hostname: 'api.fal.ai',
        port: 443,
        path: '/v1',
        scheme: 'https',
      },
      matchingPatterns: ['*.fal.ai', 'api.fal.ai'],
    };
    const trace = buildDecisionTrace(
      'api.fal.ai',
      443,
      '/v1',
      'https',
      decision,
    );
    expect(trace.decisionKind).toBe('ask_missing_credential');
    expect(trace.candidateCount).toBe(2);
  });

  test('ask_unauthenticated has zero candidates', () => {
    const decision: PolicyDecision = {
      kind: 'ask_unauthenticated',
      target: {
        hostname: 'example.com',
        port: null,
        path: '/',
        scheme: 'https',
      },
    };
    const trace = buildDecisionTrace(
      'example.com',
      null,
      '/',
      'https',
      decision,
    );
    expect(trace.decisionKind).toBe('ask_unauthenticated');
    expect(trace.candidateCount).toBe(0);
  });

  test('strips query parameters from path to prevent secret leakage', () => {
    const decision: PolicyDecision = {
      kind: 'matched',
      credentialId: 'cred-fal',
      template: {
        hostPattern: '*.fal.ai',
        injectionType: 'header',
        headerName: 'Authorization',
        valuePrefix: 'Key ',
      },
    };
    const trace = buildDecisionTrace(
      'api.fal.ai',
      443,
      '/v1/run?api_key=sk-secret-123&token=abc',
      'https',
      decision,
    );
    expect(trace.path).toBe('/v1/run');
    expect(JSON.stringify(trace)).not.toContain('sk-secret-123');
    expect(JSON.stringify(trace)).not.toContain('abc');
  });

  test('path without query string is unchanged', () => {
    const decision: PolicyDecision = { kind: 'missing' };
    const trace = buildDecisionTrace(
      'example.com',
      443,
      '/v1/models',
      'https',
      decision,
    );
    expect(trace.path).toBe('/v1/models');
  });

  test('trace never contains secret values', () => {
    const decision: PolicyDecision = {
      kind: 'matched',
      credentialId: 'cred-fal',
      template: {
        hostPattern: '*.fal.ai',
        injectionType: 'header',
        headerName: 'Authorization',
        valuePrefix: 'Key ',
      },
    };
    const trace = buildDecisionTrace('api.fal.ai', 443, '/', 'https', decision);
    const serialized = JSON.stringify(trace);
    // Should not contain any typical secret patterns
    expect(serialized).not.toContain('Bearer ');
    expect(serialized).not.toContain('Key ');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('token');
    // Should only contain expected fields
    const keys = Object.keys(trace);
    expect(keys).toEqual([
      'host',
      'port',
      'path',
      'scheme',
      'decisionKind',
      'candidateCount',
      'selectedPattern',
      'selectedCredentialId',
    ]);
  });
});

