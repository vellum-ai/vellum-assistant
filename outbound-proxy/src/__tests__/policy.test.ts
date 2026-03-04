import { describe, expect, test } from 'bun:test';

import { evaluateRequest, evaluateRequestWithApproval } from '../policy.js';
import type { CredentialInjectionTemplate } from '../types.js';

function headerTemplate(
  hostPattern: string,
  headerName = 'Authorization',
  valuePrefix = 'Key ',
): CredentialInjectionTemplate {
  return { hostPattern, injectionType: 'header', headerName, valuePrefix };
}

function queryTemplate(
  hostPattern: string,
  queryParamName: string,
): CredentialInjectionTemplate {
  return { hostPattern, injectionType: 'query', queryParamName };
}

describe('evaluateRequest', () => {
  test('returns unauthenticated when no credential_ids are provided', () => {
    const result = evaluateRequest('api.fal.ai', '/v1/run', [], new Map());
    expect(result).toEqual({ kind: 'unauthenticated' });
  });

  test('returns missing when credential_ids exist but no templates match', () => {
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-1', [headerTemplate('*.openai.com')]],
    ]);
    const result = evaluateRequest('api.fal.ai', '/', ['cred-1'], templates);
    expect(result).toEqual({ kind: 'missing' });
  });

  test('returns missing when credential_id has no templates at all', () => {
    const result = evaluateRequest(
      'api.fal.ai',
      '/',
      ['cred-unknown'],
      new Map(),
    );
    expect(result).toEqual({ kind: 'missing' });
  });

  test('returns matched for a single matching credential', () => {
    const tpl = headerTemplate('*.fal.ai');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-fal', [tpl]],
    ]);
    const result = evaluateRequest(
      'api.fal.ai',
      '/v1/run',
      ['cred-fal'],
      templates,
    );
    expect(result).toEqual({
      kind: 'matched',
      credentialId: 'cred-fal',
      template: tpl,
    });
  });

  test('returns matched with exact hostname pattern', () => {
    const tpl = headerTemplate('api.replicate.com', 'Authorization', 'Token ');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-rep', [tpl]],
    ]);
    const result = evaluateRequest(
      'api.replicate.com',
      '/v1/predictions',
      ['cred-rep'],
      templates,
    );
    expect(result).toEqual({
      kind: 'matched',
      credentialId: 'cred-rep',
      template: tpl,
    });
  });

  test('returns ambiguous when multiple credentials match', () => {
    const tpl1 = headerTemplate('*.fal.ai', 'Authorization', 'Key ');
    const tpl2 = headerTemplate('*.fal.ai', 'X-Api-Key');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-a', [tpl1]],
      ['cred-b', [tpl2]],
    ]);
    const result = evaluateRequest(
      'api.fal.ai',
      '/',
      ['cred-a', 'cred-b'],
      templates,
    );
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0]).toEqual({
        credentialId: 'cred-a',
        template: tpl1,
      });
      expect(result.candidates[1]).toEqual({
        credentialId: 'cred-b',
        template: tpl2,
      });
    }
  });

  test('only considers credentials in the credentialIds list', () => {
    const tpl = headerTemplate('*.fal.ai');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-a', [tpl]],
      ['cred-b', [headerTemplate('*.fal.ai', 'X-Key')]],
    ]);
    const result = evaluateRequest('api.fal.ai', '/', ['cred-a'], templates);
    expect(result).toEqual({
      kind: 'matched',
      credentialId: 'cred-a',
      template: tpl,
    });
  });

  test('handles multiple templates per credential -- returns first match', () => {
    const tpl1 = headerTemplate('*.openai.com');
    const tpl2 = headerTemplate('*.fal.ai');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-multi', [tpl1, tpl2]],
    ]);
    const result = evaluateRequest(
      'api.fal.ai',
      '/',
      ['cred-multi'],
      templates,
    );
    expect(result).toEqual({
      kind: 'matched',
      credentialId: 'cred-multi',
      template: tpl2,
    });
  });

  test('single credential with exact + wildcard templates picks exact', () => {
    const tpl1 = headerTemplate('*.fal.ai', 'Authorization', 'Key ');
    const tpl2 = headerTemplate('api.fal.ai', 'Authorization', 'Bearer ');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-dual', [tpl1, tpl2]],
    ]);
    const result = evaluateRequest('api.fal.ai', '/', ['cred-dual'], templates);
    expect(result).toEqual({
      kind: 'matched',
      credentialId: 'cred-dual',
      template: tpl2,
    });
  });

  test('excludes query templates from candidate matching', () => {
    const tpl = queryTemplate('maps.googleapis.com', 'key');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-gcp', [tpl]],
    ]);
    const result = evaluateRequest(
      'maps.googleapis.com',
      '/api/geocode',
      ['cred-gcp'],
      templates,
    );
    expect(result).toEqual({ kind: 'missing' });
  });

  test('query template alongside header template does not cause ambiguity', () => {
    const headerTpl = headerTemplate('maps.googleapis.com');
    const qTpl = queryTemplate('maps.googleapis.com', 'key');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-gcp', [headerTpl, qTpl]],
    ]);
    const result = evaluateRequest(
      'maps.googleapis.com',
      '/api/geocode',
      ['cred-gcp'],
      templates,
    );
    expect(result).toEqual({
      kind: 'matched',
      credentialId: 'cred-gcp',
      template: headerTpl,
    });
  });

  test('matches hostnames case-insensitively', () => {
    const tpl = headerTemplate('*.fal.ai');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-fal', [tpl]],
    ]);
    const result = evaluateRequest(
      'API.FAL.AI',
      '/v1/run',
      ['cred-fal'],
      templates,
    );
    expect(result).toEqual({
      kind: 'matched',
      credentialId: 'cred-fal',
      template: tpl,
    });
  });

  test('bare domain matches wildcard with apex-inclusive matching', () => {
    const tpl = headerTemplate('*.fal.ai');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-1', [tpl]],
    ]);
    const result = evaluateRequest('fal.ai', '/', ['cred-1'], templates);
    expect(result).toEqual({
      kind: 'matched',
      credentialId: 'cred-1',
      template: tpl,
    });
  });

  test('same-credential equal-specificity ties remain ambiguous', () => {
    const tpl1 = headerTemplate('api.fal.ai', 'Authorization', 'Key ');
    const tpl2 = headerTemplate('api.fal.ai', 'X-Api-Key', 'Bearer ');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-dual', [tpl1, tpl2]],
    ]);
    const result = evaluateRequest('api.fal.ai', '/', ['cred-dual'], templates);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
    }
  });

  test('evaluateRequest with apex-inclusive fal.run matches *.fal.run', () => {
    const tpl = headerTemplate('*.fal.run');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-fal', [tpl]],
    ]);
    const result = evaluateRequest('fal.run', '/', ['cred-fal'], templates);
    expect(result).toEqual({
      kind: 'matched',
      credentialId: 'cred-fal',
      template: tpl,
    });
  });

  test('credential with no templates in map is skipped gracefully', () => {
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-a', []],
    ]);
    const result = evaluateRequest('api.fal.ai', '/', ['cred-a'], templates);
    expect(result).toEqual({ kind: 'missing' });
  });

  test('multiple credential IDs where only one has templates', () => {
    const tpl = headerTemplate('*.fal.ai');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-fal', [tpl]],
    ]);
    const result = evaluateRequest(
      'api.fal.ai',
      '/',
      ['cred-missing', 'cred-fal'],
      templates,
    );
    expect(result).toEqual({
      kind: 'matched',
      credentialId: 'cred-fal',
      template: tpl,
    });
  });
});

describe('evaluateRequestWithApproval', () => {
  test('passes through matched decisions unchanged', () => {
    const tpl = headerTemplate('*.fal.ai');
    const sessionTemplates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-fal', [tpl]],
    ]);
    const result = evaluateRequestWithApproval(
      'api.fal.ai',
      443,
      '/v1/run',
      ['cred-fal'],
      sessionTemplates,
      [tpl],
    );
    expect(result).toEqual({
      kind: 'matched',
      credentialId: 'cred-fal',
      template: tpl,
    });
  });

  test('passes through ambiguous decisions unchanged', () => {
    const tpl1 = headerTemplate('*.fal.ai', 'Authorization', 'Key ');
    const tpl2 = headerTemplate('*.fal.ai', 'X-Api-Key');
    const sessionTemplates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-a', [tpl1]],
      ['cred-b', [tpl2]],
    ]);
    const result = evaluateRequestWithApproval(
      'api.fal.ai',
      null,
      '/',
      ['cred-a', 'cred-b'],
      sessionTemplates,
      [tpl1, tpl2],
    );
    expect(result.kind).toBe('ambiguous');
  });

  test('returns ask_missing_credential when host matches a known template but session has no matching credential', () => {
    const sessionTpl = headerTemplate('*.openai.com');
    const sessionTemplates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-openai', [sessionTpl]],
    ]);
    const knownFalTpl = headerTemplate('*.fal.ai');
    const allKnown = [sessionTpl, knownFalTpl];

    const result = evaluateRequestWithApproval(
      'api.fal.ai',
      443,
      '/v1/run',
      ['cred-openai'],
      sessionTemplates,
      allKnown,
    );
    expect(result).toEqual({
      kind: 'ask_missing_credential',
      target: {
        hostname: 'api.fal.ai',
        port: 443,
        path: '/v1/run',
        scheme: 'https',
      },
      matchingPatterns: ['*.fal.ai'],
    });
  });

  test('returns ask_missing_credential with deduplicated patterns', () => {
    const sessionTemplates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-openai', [headerTemplate('*.openai.com')]],
    ]);
    const allKnown = [
      headerTemplate('*.fal.ai', 'Authorization', 'Key '),
      headerTemplate('*.fal.ai', 'X-Api-Key'),
    ];

    const result = evaluateRequestWithApproval(
      'api.fal.ai',
      null,
      '/',
      ['cred-openai'],
      sessionTemplates,
      allKnown,
    );
    expect(result.kind).toBe('ask_missing_credential');
    if (result.kind === 'ask_missing_credential') {
      expect(result.matchingPatterns).toEqual(['*.fal.ai']);
    }
  });

  test('returns ask_missing_credential when session has credentials but none have templates', () => {
    const sessionTemplates = new Map<string, CredentialInjectionTemplate[]>();
    const allKnown = [headerTemplate('*.fal.ai')];

    const result = evaluateRequestWithApproval(
      'api.fal.ai',
      8080,
      '/generate',
      ['cred-unknown'],
      sessionTemplates,
      allKnown,
    );
    expect(result).toEqual({
      kind: 'ask_missing_credential',
      target: {
        hostname: 'api.fal.ai',
        port: 8080,
        path: '/generate',
        scheme: 'https',
      },
      matchingPatterns: ['*.fal.ai'],
    });
  });

  test('returns ask_unauthenticated when no credentials and host is unknown', () => {
    const result = evaluateRequestWithApproval(
      'example.com',
      null,
      '/data',
      [],
      new Map(),
      [],
    );
    expect(result).toEqual({
      kind: 'ask_unauthenticated',
      target: {
        hostname: 'example.com',
        port: null,
        path: '/data',
        scheme: 'https',
      },
    });
  });

  test('returns ask_unauthenticated when no credentials and registry has templates for other hosts', () => {
    const allKnown = [headerTemplate('*.fal.ai')];

    const result = evaluateRequestWithApproval(
      'example.com',
      443,
      '/',
      [],
      new Map(),
      allKnown,
    );
    expect(result).toEqual({
      kind: 'ask_unauthenticated',
      target: {
        hostname: 'example.com',
        port: 443,
        path: '/',
        scheme: 'https',
      },
    });
  });

  test('returns ask_unauthenticated when session has credentials but host is completely unknown', () => {
    const sessionTpl = headerTemplate('*.openai.com');
    const sessionTemplates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-openai', [sessionTpl]],
    ]);

    const result = evaluateRequestWithApproval(
      'unknown-service.internal',
      null,
      '/api',
      ['cred-openai'],
      sessionTemplates,
      [sessionTpl],
    );
    expect(result).toEqual({
      kind: 'ask_unauthenticated',
      target: {
        hostname: 'unknown-service.internal',
        port: null,
        path: '/api',
        scheme: 'https',
      },
    });
  });

  test('includes port in target context', () => {
    const result = evaluateRequestWithApproval(
      'localhost',
      3000,
      '/webhook',
      [],
      new Map(),
      [],
    );
    expect(result.kind).toBe('ask_unauthenticated');
    if (result.kind === 'ask_unauthenticated') {
      expect(result.target).toEqual({
        hostname: 'localhost',
        port: 3000,
        path: '/webhook',
        scheme: 'https',
      });
    }
  });

  test('respects scheme parameter', () => {
    const result = evaluateRequestWithApproval(
      'example.com',
      null,
      '/data',
      [],
      new Map(),
      [],
      'http',
    );
    expect(result.kind).toBe('ask_unauthenticated');
    if (result.kind === 'ask_unauthenticated') {
      expect(result.target.scheme).toBe('http');
    }
  });

  test('excludes query templates from allKnown matching', () => {
    const sessionTemplates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-a', [headerTemplate('*.openai.com')]],
    ]);
    // Only query templates match the host in allKnown
    const allKnown = [queryTemplate('api.fal.ai', 'key')];

    const result = evaluateRequestWithApproval(
      'api.fal.ai',
      null,
      '/',
      ['cred-a'],
      sessionTemplates,
      allKnown,
    );
    // Should be ask_unauthenticated since query templates are excluded
    expect(result.kind).toBe('ask_unauthenticated');
  });
});
