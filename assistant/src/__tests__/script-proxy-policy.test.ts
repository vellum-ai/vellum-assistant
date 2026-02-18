import { describe, expect, test } from 'bun:test';
import { evaluateRequest } from '../tools/network/script-proxy/policy.js';
import type { CredentialInjectionTemplate } from '../tools/credentials/policy-types.js';

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
    const result = evaluateRequest('api.fal.ai', '/', ['cred-unknown'], new Map());
    expect(result).toEqual({ kind: 'missing' });
  });

  test('returns matched for a single matching credential', () => {
    const tpl = headerTemplate('*.fal.ai');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-fal', [tpl]],
    ]);
    const result = evaluateRequest('api.fal.ai', '/v1/run', ['cred-fal'], templates);
    expect(result).toEqual({ kind: 'matched', credentialId: 'cred-fal', template: tpl });
  });

  test('returns matched with exact hostname pattern', () => {
    const tpl = headerTemplate('api.replicate.com', 'Authorization', 'Token ');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-rep', [tpl]],
    ]);
    const result = evaluateRequest('api.replicate.com', '/v1/predictions', ['cred-rep'], templates);
    expect(result).toEqual({ kind: 'matched', credentialId: 'cred-rep', template: tpl });
  });

  test('returns ambiguous when multiple credentials match', () => {
    const tpl1 = headerTemplate('*.fal.ai', 'Authorization', 'Key ');
    const tpl2 = headerTemplate('*.fal.ai', 'X-Api-Key');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-a', [tpl1]],
      ['cred-b', [tpl2]],
    ]);
    const result = evaluateRequest('api.fal.ai', '/', ['cred-a', 'cred-b'], templates);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
      expect(result.candidates[0]).toEqual({ credentialId: 'cred-a', template: tpl1 });
      expect(result.candidates[1]).toEqual({ credentialId: 'cred-b', template: tpl2 });
    }
  });

  test('only considers credentials in the credentialIds list', () => {
    const tpl = headerTemplate('*.fal.ai');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-a', [tpl]],
      ['cred-b', [headerTemplate('*.fal.ai', 'X-Key')]],
    ]);
    // Only cred-a is in the allowed list
    const result = evaluateRequest('api.fal.ai', '/', ['cred-a'], templates);
    expect(result).toEqual({ kind: 'matched', credentialId: 'cred-a', template: tpl });
  });

  test('handles multiple templates per credential — returns first match', () => {
    const tpl1 = headerTemplate('*.openai.com');
    const tpl2 = headerTemplate('*.fal.ai');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-multi', [tpl1, tpl2]],
    ]);
    const result = evaluateRequest('api.fal.ai', '/', ['cred-multi'], templates);
    expect(result).toEqual({ kind: 'matched', credentialId: 'cred-multi', template: tpl2 });
  });

  test('returns ambiguous when one credential matches multiple templates', () => {
    const tpl1 = headerTemplate('*.fal.ai', 'Authorization', 'Key ');
    const tpl2 = headerTemplate('api.fal.ai', 'Authorization', 'Bearer ');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-dual', [tpl1, tpl2]],
    ]);
    const result = evaluateRequest('api.fal.ai', '/', ['cred-dual'], templates);
    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toHaveLength(2);
    }
  });

  test('works with query injection templates', () => {
    const tpl = queryTemplate('maps.googleapis.com', 'key');
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-gcp', [tpl]],
    ]);
    const result = evaluateRequest('maps.googleapis.com', '/api/geocode', ['cred-gcp'], templates);
    expect(result).toEqual({ kind: 'matched', credentialId: 'cred-gcp', template: tpl });
  });

  test('non-matching hostname with glob returns missing', () => {
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-1', [headerTemplate('*.fal.ai')]],
    ]);
    const result = evaluateRequest('fal.ai', '/', ['cred-1'], templates);
    // "*.fal.ai" does not match bare "fal.ai" with minimatch
    expect(result).toEqual({ kind: 'missing' });
  });
});
