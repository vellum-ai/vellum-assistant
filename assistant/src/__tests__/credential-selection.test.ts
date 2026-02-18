import { describe, test, expect } from 'bun:test';
import { rankCredentialsForEndpoint } from '../tools/credentials/selection.js';
import type { CredentialMetadata } from '../tools/credentials/metadata-store.js';

function makeCred(overrides: Partial<CredentialMetadata> & { credentialId: string }): CredentialMetadata {
  return {
    service: 'test',
    field: 'api_key',
    allowedTools: [],
    allowedDomains: [],
    createdAt: 1000000,
    updatedAt: 1000000,
    ...overrides,
  };
}

describe('rankCredentialsForEndpoint', () => {
  test('returns null topChoice for empty credentials list', () => {
    const result = rankCredentialsForEndpoint([], 'api.example.com');
    expect(result.topChoice).toBeNull();
    expect(result.candidates).toHaveLength(0);
    expect(result.ambiguous).toBe(false);
  });

  test('exact host match ranks higher than wildcard', () => {
    const creds = [
      makeCred({
        credentialId: 'wildcard',
        injectionTemplates: [{ hostPattern: '*.fal.ai', injectionType: 'header', headerName: 'Authorization' }],
      }),
      makeCred({
        credentialId: 'exact',
        injectionTemplates: [{ hostPattern: 'queue.fal.ai', injectionType: 'header', headerName: 'Authorization' }],
      }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'queue.fal.ai');
    expect(result.topChoice?.credentialId).toBe('exact');
    expect(result.topChoice?.confidence).toBe('high');
    expect(result.ambiguous).toBe(false);
  });

  test('wildcard match ranks higher than no template match', () => {
    const creds = [
      makeCred({ credentialId: 'no-template' }),
      makeCred({
        credentialId: 'wildcard',
        injectionTemplates: [{ hostPattern: '*.openai.com', injectionType: 'header', headerName: 'Authorization' }],
      }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'api.openai.com');
    expect(result.topChoice?.credentialId).toBe('wildcard');
    expect(result.topChoice?.confidence).toBe('medium');
  });

  test('wildcard *.example.com also matches bare example.com', () => {
    const creds = [
      makeCred({
        credentialId: 'wild',
        injectionTemplates: [{ hostPattern: '*.example.com', injectionType: 'header' }],
      }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'example.com');
    expect(result.topChoice?.credentialId).toBe('wild');
    expect(result.topChoice?.confidence).toBe('medium');
  });

  test('alias set boosts score', () => {
    const creds = [
      makeCred({ credentialId: 'no-alias', updatedAt: 2000000 }),
      makeCred({ credentialId: 'with-alias', alias: 'primary-key', updatedAt: 1000000 }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'api.example.com');
    expect(result.topChoice?.credentialId).toBe('with-alias');
  });

  test('recency breaks ties when host specificity and alias are equal', () => {
    const creds = [
      makeCred({ credentialId: 'older', updatedAt: 1000000 }),
      makeCred({ credentialId: 'newer', updatedAt: 2000000 }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'api.example.com');
    expect(result.topChoice?.credentialId).toBe('newer');
  });

  test('filters out credentials with non-matching allowedDomains', () => {
    const creds = [
      makeCred({
        credentialId: 'restricted',
        allowedDomains: ['other.com'],
      }),
      makeCred({
        credentialId: 'unrestricted',
        // empty allowedDomains = no restriction
      }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'api.example.com');
    expect(result.candidates).toHaveLength(1);
    expect(result.topChoice?.credentialId).toBe('unrestricted');
  });

  test('allowedDomains with wildcard pattern allows matching hosts', () => {
    const creds = [
      makeCred({
        credentialId: 'domain-match',
        allowedDomains: ['*.fal.ai'],
        injectionTemplates: [{ hostPattern: '*.fal.ai', injectionType: 'header', headerName: 'Authorization' }],
      }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'queue.fal.ai');
    expect(result.candidates).toHaveLength(1);
    expect(result.topChoice?.credentialId).toBe('domain-match');
  });

  test('ambiguous is true when top two candidates are in the same scoring tier', () => {
    const creds = [
      makeCred({
        credentialId: 'a',
        injectionTemplates: [{ hostPattern: '*.api.com', injectionType: 'header' }],
        updatedAt: 1000001,
      }),
      makeCred({
        credentialId: 'b',
        injectionTemplates: [{ hostPattern: '*.api.com', injectionType: 'header' }],
        updatedAt: 1000000,
      }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'v1.api.com');
    expect(result.ambiguous).toBe(true);
    expect(result.topChoice?.confidence).toBe('low');
  });

  test('ambiguous is false when top candidate is in a strictly higher tier', () => {
    const creds = [
      makeCred({
        credentialId: 'exact',
        injectionTemplates: [{ hostPattern: 'api.example.com', injectionType: 'header' }],
      }),
      makeCred({
        credentialId: 'wildcard',
        injectionTemplates: [{ hostPattern: '*.example.com', injectionType: 'header' }],
      }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'api.example.com');
    expect(result.ambiguous).toBe(false);
    expect(result.topChoice?.credentialId).toBe('exact');
  });

  test('candidates are sorted descending by score', () => {
    const creds = [
      makeCred({ credentialId: 'low', updatedAt: 1000000 }),
      makeCred({
        credentialId: 'high',
        injectionTemplates: [{ hostPattern: 'api.test.com', injectionType: 'header' }],
        alias: 'primary',
        updatedAt: 2000000,
      }),
      makeCred({
        credentialId: 'mid',
        injectionTemplates: [{ hostPattern: '*.test.com', injectionType: 'header' }],
        updatedAt: 1500000,
      }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'api.test.com');
    expect(result.candidates.map((c) => c.credentialId)).toEqual(['high', 'mid', 'low']);
  });

  test('match reasons reflect actual matching criteria', () => {
    const creds = [
      makeCred({
        credentialId: 'full',
        injectionTemplates: [{ hostPattern: 'api.test.com', injectionType: 'header' }],
        alias: 'my-key',
      }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'api.test.com');
    expect(result.candidates[0].matchReason).toContain('exact host match');
    expect(result.candidates[0].matchReason).toContain('alias set');
  });

  test('credential with no templates and no alias gets domain allowed reason', () => {
    const creds = [makeCred({ credentialId: 'basic' })];
    const result = rankCredentialsForEndpoint(creds, 'api.test.com');
    expect(result.candidates[0].matchReason).toBe('domain allowed');
  });

  test('single credential returns non-ambiguous result', () => {
    const creds = [
      makeCred({
        credentialId: 'only',
        injectionTemplates: [{ hostPattern: '*.example.com', injectionType: 'query', queryParamName: 'key' }],
      }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'api.example.com');
    expect(result.ambiguous).toBe(false);
    expect(result.topChoice?.credentialId).toBe('only');
    expect(result.topChoice?.confidence).toBe('medium');
    expect(result.candidates).toHaveLength(1);
  });

  test('host matching is case-insensitive', () => {
    const creds = [
      makeCred({
        credentialId: 'case',
        injectionTemplates: [{ hostPattern: 'API.Example.COM', injectionType: 'header' }],
      }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'api.example.com');
    expect(result.topChoice?.credentialId).toBe('case');
    expect(result.topChoice?.confidence).toBe('high');
  });
});
