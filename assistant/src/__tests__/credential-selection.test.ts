import { describe, test, expect } from 'bun:test';
import { rankCredentialsForEndpoint } from '../tools/credentials/selection.js';
import type { CredentialMetadata } from '../tools/credentials/metadata-store.js';

// Realistic epoch-millisecond timestamps (similar to Date.now())
const NOW = 1_770_000_000_000;
const ONE_HOUR_AGO = NOW - 3_600_000;
const ONE_DAY_AGO = NOW - 86_400_000;
const ONE_WEEK_AGO = NOW - 604_800_000;

function makeCred(overrides: Partial<CredentialMetadata> & { credentialId: string }): CredentialMetadata {
  return {
    service: 'test',
    field: 'api_key',
    allowedTools: [],
    allowedDomains: [],
    createdAt: ONE_DAY_AGO,
    updatedAt: ONE_DAY_AGO,
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
        updatedAt: NOW,
      }),
      makeCred({
        credentialId: 'exact',
        injectionTemplates: [{ hostPattern: 'queue.fal.ai', injectionType: 'header', headerName: 'Authorization' }],
        updatedAt: ONE_WEEK_AGO,
      }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'queue.fal.ai');
    expect(result.topChoice?.credentialId).toBe('exact');
    expect(result.topChoice?.confidence).toBe('high');
    expect(result.ambiguous).toBe(false);
  });

  test('wildcard match ranks higher than no template match', () => {
    const creds = [
      makeCred({ credentialId: 'no-template', updatedAt: NOW }),
      makeCred({
        credentialId: 'wildcard',
        injectionTemplates: [{ hostPattern: '*.openai.com', injectionType: 'header', headerName: 'Authorization' }],
        updatedAt: ONE_WEEK_AGO,
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
      makeCred({ credentialId: 'no-alias', updatedAt: NOW }),
      makeCred({ credentialId: 'with-alias', alias: 'primary-key', updatedAt: ONE_WEEK_AGO }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'api.example.com');
    expect(result.topChoice?.credentialId).toBe('with-alias');
  });

  test('recency breaks ties when host specificity and alias are equal', () => {
    const creds = [
      makeCred({ credentialId: 'older', updatedAt: ONE_DAY_AGO }),
      makeCred({ credentialId: 'newer', updatedAt: NOW }),
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

  test('allowedDomains with registrable-domain match allows subdomains', () => {
    const creds = [
      makeCred({
        credentialId: 'domain-match',
        allowedDomains: ['fal.ai'],
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
        updatedAt: NOW,
      }),
      makeCred({
        credentialId: 'b',
        injectionTemplates: [{ hostPattern: '*.api.com', injectionType: 'header' }],
        updatedAt: ONE_HOUR_AGO,
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
        updatedAt: ONE_WEEK_AGO,
      }),
      makeCred({
        credentialId: 'wildcard',
        injectionTemplates: [{ hostPattern: '*.example.com', injectionType: 'header' }],
        updatedAt: NOW,
      }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'api.example.com');
    expect(result.ambiguous).toBe(false);
    expect(result.topChoice?.credentialId).toBe('exact');
  });

  test('candidates are sorted descending by score', () => {
    const creds = [
      makeCred({ credentialId: 'low', updatedAt: NOW }),
      makeCred({
        credentialId: 'high',
        injectionTemplates: [{ hostPattern: 'api.test.com', injectionType: 'header' }],
        alias: 'primary',
        updatedAt: ONE_WEEK_AGO,
      }),
      makeCred({
        credentialId: 'mid',
        injectionTemplates: [{ hostPattern: '*.test.com', injectionType: 'header' }],
        updatedAt: ONE_DAY_AGO,
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

  test('tier score always dominates recency even with real timestamps', () => {
    const creds = [
      makeCred({
        credentialId: 'old-exact',
        injectionTemplates: [{ hostPattern: 'api.example.com', injectionType: 'header' }],
        updatedAt: ONE_WEEK_AGO,
      }),
      makeCred({
        credentialId: 'new-no-match',
        updatedAt: NOW,
      }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'api.example.com');
    // Exact host match must always win over recency
    expect(result.topChoice?.credentialId).toBe('old-exact');
    expect(result.topChoice?.confidence).toBe('high');
  });
});

describe('multi-key same-service selection', () => {
  test('two OpenAI credentials targeting the same endpoint — deterministic chosen credential_id', () => {
    const creds = [
      makeCred({
        credentialId: 'openai-key-1',
        service: 'openai',
        injectionTemplates: [{ hostPattern: 'api.openai.com', injectionType: 'header', headerName: 'Authorization' }],
        updatedAt: ONE_DAY_AGO,
      }),
      makeCred({
        credentialId: 'openai-key-2',
        service: 'openai',
        injectionTemplates: [{ hostPattern: 'api.openai.com', injectionType: 'header', headerName: 'Authorization' }],
        updatedAt: NOW,
      }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'api.openai.com');
    // Both have exact host match (tier score 100) — same tier, so ambiguous
    expect(result.ambiguous).toBe(true);
    expect(result.topChoice?.confidence).toBe('low');
    // Despite ambiguity, topChoice is deterministic: the more recent key wins.
    expect(result.topChoice?.credentialId).toBe('openai-key-2');
    expect(result.candidates).toHaveLength(2);
  });

  test('ambiguity fallback path when two credentials have identical scores', () => {
    const creds = [
      makeCred({
        credentialId: 'key-a',
        service: 'openai',
        injectionTemplates: [{ hostPattern: '*.openai.com', injectionType: 'header', headerName: 'Authorization' }],
        updatedAt: ONE_DAY_AGO,
      }),
      makeCred({
        credentialId: 'key-b',
        service: 'openai',
        injectionTemplates: [{ hostPattern: '*.openai.com', injectionType: 'header', headerName: 'Authorization' }],
        updatedAt: ONE_DAY_AGO,
      }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'api.openai.com');
    expect(result.ambiguous).toBe(true);
    expect(result.topChoice?.confidence).toBe('low');
    // Both candidates are present
    expect(result.candidates).toHaveLength(2);
  });

  test('one credential with specific host template wins over one with generic template', () => {
    const creds = [
      makeCred({
        credentialId: 'generic-key',
        service: 'openai',
        injectionTemplates: [{ hostPattern: '*.openai.com', injectionType: 'header', headerName: 'Authorization' }],
        updatedAt: NOW,
      }),
      makeCred({
        credentialId: 'specific-key',
        service: 'openai',
        injectionTemplates: [{ hostPattern: 'api.openai.com', injectionType: 'header', headerName: 'Authorization' }],
        updatedAt: ONE_WEEK_AGO,
      }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'api.openai.com');
    // exact host (100) vs wildcard (50) — not ambiguous, specific key wins even though it's older
    expect(result.topChoice?.credentialId).toBe('specific-key');
    expect(result.topChoice?.confidence).toBe('high');
    expect(result.ambiguous).toBe(false);
  });

  test('both credentials have aliases — alias alone does not break ties', () => {
    const creds = [
      makeCred({
        credentialId: 'aliased-1',
        service: 'openai',
        alias: 'production-key',
        injectionTemplates: [{ hostPattern: 'api.openai.com', injectionType: 'header', headerName: 'Authorization' }],
        updatedAt: ONE_DAY_AGO,
      }),
      makeCred({
        credentialId: 'aliased-2',
        service: 'openai',
        alias: 'staging-key',
        injectionTemplates: [{ hostPattern: 'api.openai.com', injectionType: 'header', headerName: 'Authorization' }],
        updatedAt: ONE_DAY_AGO,
      }),
    ];

    const result = rankCredentialsForEndpoint(creds, 'api.openai.com');
    // Both have exact host (100) + alias (10) = 110 tier score + identical recency
    expect(result.ambiguous).toBe(true);
    expect(result.topChoice?.confidence).toBe('low');
    expect(result.candidates).toHaveLength(2);
    // Both candidates have same tier score
    expect(result.candidates[0].score).toBe(result.candidates[1].score);
  });
});
