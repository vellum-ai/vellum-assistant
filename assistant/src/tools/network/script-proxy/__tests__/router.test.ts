import { describe, test, expect } from 'bun:test';
import { routeConnection } from '../router.js';
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

describe('routeConnection', () => {
  test('tunnels when no credentials', () => {
    const result = routeConnection('api.example.com', 443, [], new Map());
    expect(result.action).toBe('tunnel');
    expect(result.reason).toBe('tunnel:no_credentials');
  });

  test('tunnels when credentials exist but no template matches', () => {
    const templates = new Map<string, readonly CredentialInjectionTemplate[]>();
    templates.set('cred-1', [makeTemplate({ hostPattern: '*.other.com' })]);
    const result = routeConnection('api.example.com', 443, ['cred-1'], templates);
    expect(result.action).toBe('tunnel');
    expect(result.reason).toBe('tunnel:no_rewrite');
  });

  test('tunnels when credential has no templates in map', () => {
    const templates = new Map<string, readonly CredentialInjectionTemplate[]>();
    const result = routeConnection('api.example.com', 443, ['cred-1'], templates);
    expect(result.action).toBe('tunnel');
    expect(result.reason).toBe('tunnel:no_rewrite');
  });

  test('MITMs when wildcard template matches', () => {
    const templates = new Map<string, readonly CredentialInjectionTemplate[]>();
    templates.set('cred-1', [makeTemplate({ hostPattern: '*.example.com' })]);
    const result = routeConnection('api.example.com', 443, ['cred-1'], templates);
    expect(result.action).toBe('mitm');
    expect(result.reason).toBe('mitm:credential_injection');
  });

  test('MITMs when exact template matches', () => {
    const templates = new Map<string, readonly CredentialInjectionTemplate[]>();
    templates.set('cred-1', [makeTemplate({ hostPattern: 'api.example.com' })]);
    const result = routeConnection('api.example.com', 443, ['cred-1'], templates);
    expect(result.action).toBe('mitm');
    expect(result.reason).toBe('mitm:credential_injection');
  });

  test('MITMs when any credential matches (first wins)', () => {
    const templates = new Map<string, readonly CredentialInjectionTemplate[]>();
    templates.set('cred-1', [makeTemplate({ hostPattern: '*.other.com' })]);
    templates.set('cred-2', [makeTemplate({ hostPattern: '*.example.com' })]);
    const result = routeConnection('api.example.com', 443, ['cred-1', 'cred-2'], templates);
    expect(result.action).toBe('mitm');
    expect(result.reason).toBe('mitm:credential_injection');
  });

  test('wildcard matches bare apex domain with includeApexForWildcard', () => {
    const templates = new Map<string, readonly CredentialInjectionTemplate[]>();
    templates.set('cred-1', [makeTemplate({ hostPattern: '*.example.com' })]);
    const result = routeConnection('example.com', 443, ['cred-1'], templates);
    expect(result.action).toBe('mitm');
    expect(result.reason).toBe('mitm:credential_injection');
  });

  test('case-insensitive matching', () => {
    const templates = new Map<string, readonly CredentialInjectionTemplate[]>();
    templates.set('cred-1', [makeTemplate({ hostPattern: '*.EXAMPLE.COM' })]);
    const result = routeConnection('API.example.com', 443, ['cred-1'], templates);
    expect(result.action).toBe('mitm');
  });
});
