import { describe, test, expect } from 'bun:test';
import { evaluateRequest, evaluateRequestWithApproval } from '../policy.js';
import type { CredentialInjectionTemplate } from '../../../credentials/policy-types.js';

function makeTemplate(overrides: Partial<CredentialInjectionTemplate> = {}): CredentialInjectionTemplate {
  return {
    hostPattern: '*.example.com',
    injectionType: 'header',
    headerName: 'Authorization',
    valuePrefix: 'Bearer ',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// evaluateRequest
// ---------------------------------------------------------------------------

describe('evaluateRequest', () => {
  test('returns unauthenticated when no credential IDs', () => {
    const result = evaluateRequest('api.example.com', '/', [], new Map());
    expect(result.kind).toBe('unauthenticated');
  });

  test('returns missing when credential has no templates', () => {
    const result = evaluateRequest('api.example.com', '/', ['cred-1'], new Map());
    expect(result.kind).toBe('missing');
  });

  test('returns missing when no template matches the host', () => {
    const templates = new Map<string, CredentialInjectionTemplate[]>();
    templates.set('cred-1', [makeTemplate({ hostPattern: '*.other.com' })]);
    const result = evaluateRequest('api.example.com', '/', ['cred-1'], templates);
    expect(result.kind).toBe('missing');
  });

  test('returns matched for exact host match', () => {
    const tpl = makeTemplate({ hostPattern: 'api.example.com' });
    const templates = new Map<string, CredentialInjectionTemplate[]>();
    templates.set('cred-1', [tpl]);
    const result = evaluateRequest('api.example.com', '/', ['cred-1'], templates);
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') {
      expect(result.credentialId).toBe('cred-1');
      expect(result.template).toBe(tpl);
    }
  });

  test('returns matched for wildcard host match', () => {
    const tpl = makeTemplate({ hostPattern: '*.example.com' });
    const templates = new Map<string, CredentialInjectionTemplate[]>();
    templates.set('cred-1', [tpl]);
    const result = evaluateRequest('api.example.com', '/', ['cred-1'], templates);
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') {
      expect(result.credentialId).toBe('cred-1');
    }
  });

  test('prefers exact match over wildcard for same credential', () => {
    const wildcard = makeTemplate({ hostPattern: '*.example.com', headerName: 'X-Wildcard' });
    const exact = makeTemplate({ hostPattern: 'api.example.com', headerName: 'X-Exact' });
    const templates = new Map<string, CredentialInjectionTemplate[]>();
    templates.set('cred-1', [wildcard, exact]);
    const result = evaluateRequest('api.example.com', '/', ['cred-1'], templates);
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') {
      expect(result.template.headerName).toBe('X-Exact');
    }
  });

  test('returns ambiguous for same-specificity tie within one credential', () => {
    const tpl1 = makeTemplate({ hostPattern: '*.example.com', headerName: 'X-One' });
    const tpl2 = makeTemplate({ hostPattern: '*.example.com', headerName: 'X-Two' });
    const templates = new Map<string, CredentialInjectionTemplate[]>();
    templates.set('cred-1', [tpl1, tpl2]);
    const result = evaluateRequest('api.example.com', '/', ['cred-1'], templates);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
    }
  });

  test('returns ambiguous for cross-credential match', () => {
    const tpl1 = makeTemplate({ hostPattern: '*.example.com' });
    const tpl2 = makeTemplate({ hostPattern: '*.example.com' });
    const templates = new Map<string, CredentialInjectionTemplate[]>();
    templates.set('cred-1', [tpl1]);
    templates.set('cred-2', [tpl2]);
    const result = evaluateRequest('api.example.com', '/', ['cred-1', 'cred-2'], templates);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
    }
  });

  test('skips query-type injection templates', () => {
    const tpl = makeTemplate({
      hostPattern: '*.example.com',
      injectionType: 'query',
      queryParamName: 'api_key',
      headerName: undefined,
    });
    const templates = new Map<string, CredentialInjectionTemplate[]>();
    templates.set('cred-1', [tpl]);
    const result = evaluateRequest('api.example.com', '/', ['cred-1'], templates);
    expect(result.kind).toBe('missing');
  });

  test('wildcard with includeApexForWildcard matches bare domain', () => {
    const tpl = makeTemplate({ hostPattern: '*.example.com' });
    const templates = new Map<string, CredentialInjectionTemplate[]>();
    templates.set('cred-1', [tpl]);
    const result = evaluateRequest('example.com', '/', ['cred-1'], templates);
    expect(result.kind).toBe('matched');
  });
});

// ---------------------------------------------------------------------------
// evaluateRequestWithApproval
// ---------------------------------------------------------------------------

describe('evaluateRequestWithApproval', () => {
  test('passes through matched decisions', () => {
    const tpl = makeTemplate({ hostPattern: 'api.example.com' });
    const sessionTemplates = new Map<string, CredentialInjectionTemplate[]>();
    sessionTemplates.set('cred-1', [tpl]);
    const result = evaluateRequestWithApproval(
      'api.example.com', null, '/',
      ['cred-1'], sessionTemplates, [],
    );
    expect(result.kind).toBe('matched');
  });

  test('passes through ambiguous decisions', () => {
    const tpl1 = makeTemplate({ hostPattern: '*.example.com', headerName: 'X-One' });
    const tpl2 = makeTemplate({ hostPattern: '*.example.com', headerName: 'X-Two' });
    const sessionTemplates = new Map<string, CredentialInjectionTemplate[]>();
    sessionTemplates.set('cred-1', [tpl1, tpl2]);
    const result = evaluateRequestWithApproval(
      'api.example.com', null, '/',
      ['cred-1'], sessionTemplates, [],
    );
    expect(result.kind).toBe('ambiguous');
  });

  test('returns ask_missing_credential when known templates match', () => {
    const sessionTemplates = new Map<string, CredentialInjectionTemplate[]>();
    const allKnown = [makeTemplate({ hostPattern: '*.example.com' })];
    const result = evaluateRequestWithApproval(
      'api.example.com', 443, '/api',
      ['cred-1'], sessionTemplates, allKnown,
    );
    expect(result.kind).toBe('ask_missing_credential');
    if (result.kind === 'ask_missing_credential') {
      expect(result.target.hostname).toBe('api.example.com');
      expect(result.target.port).toBe(443);
      expect(result.target.path).toBe('/api');
      expect(result.matchingPatterns).toContain('*.example.com');
    }
  });

  test('deduplicates matching patterns', () => {
    const sessionTemplates = new Map<string, CredentialInjectionTemplate[]>();
    const allKnown = [
      makeTemplate({ hostPattern: '*.example.com', headerName: 'X-One' }),
      makeTemplate({ hostPattern: '*.example.com', headerName: 'X-Two' }),
    ];
    const result = evaluateRequestWithApproval(
      'api.example.com', null, '/',
      ['cred-1'], sessionTemplates, allKnown,
    );
    expect(result.kind).toBe('ask_missing_credential');
    if (result.kind === 'ask_missing_credential') {
      expect(result.matchingPatterns).toEqual(['*.example.com']);
    }
  });

  test('returns ask_unauthenticated when no known templates match and no credentials', () => {
    const sessionTemplates = new Map<string, CredentialInjectionTemplate[]>();
    const result = evaluateRequestWithApproval(
      'unknown.example.com', null, '/',
      [], sessionTemplates, [],
    );
    expect(result.kind).toBe('ask_unauthenticated');
    if (result.kind === 'ask_unauthenticated') {
      expect(result.target.hostname).toBe('unknown.example.com');
      expect(result.target.scheme).toBe('https');
    }
  });

  test('returns ask_unauthenticated for unknown host even with known templates for other hosts', () => {
    const sessionTemplates = new Map<string, CredentialInjectionTemplate[]>();
    const allKnown = [makeTemplate({ hostPattern: '*.other.com' })];
    const result = evaluateRequestWithApproval(
      'unknown.example.com', null, '/',
      [], sessionTemplates, allKnown,
    );
    expect(result.kind).toBe('ask_unauthenticated');
  });

  test('skips query templates when scanning allKnownTemplates', () => {
    const sessionTemplates = new Map<string, CredentialInjectionTemplate[]>();
    const allKnown = [makeTemplate({
      hostPattern: '*.example.com',
      injectionType: 'query',
      queryParamName: 'key',
      headerName: undefined,
    })];
    const result = evaluateRequestWithApproval(
      'api.example.com', null, '/',
      ['cred-1'], sessionTemplates, allKnown,
    );
    // Query templates are skipped, so no pattern matches → ask_unauthenticated
    // But credentialIds is non-empty so base is 'missing' → then no known header templates → ask_unauthenticated
    // Actually: credentialIds=['cred-1'] but sessionTemplates is empty → base='missing'
    // allKnown only has query type → no header matches → falls through to ask_unauthenticated
    // Wait: base is 'missing' (not unauthenticated), and uniquePatterns.length===0
    // For 'missing' with no matching patterns, the function returns ask_unauthenticated
    expect(result.kind).toBe('ask_unauthenticated');
  });

  test('uses provided scheme parameter', () => {
    const sessionTemplates = new Map<string, CredentialInjectionTemplate[]>();
    const result = evaluateRequestWithApproval(
      'unknown.example.com', 80, '/',
      [], sessionTemplates, [], 'http',
    );
    expect(result.kind).toBe('ask_unauthenticated');
    if (result.kind === 'ask_unauthenticated') {
      expect(result.target.scheme).toBe('http');
    }
  });
});
