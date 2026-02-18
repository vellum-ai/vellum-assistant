import { describe, expect, test } from 'bun:test';
import { routeConnection, type RouteDecision } from '../tools/network/script-proxy/router.js';
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

describe('routeConnection', () => {
  // -- tunnel:no_credentials -------------------------------------------------

  test('returns tunnel:no_credentials when credentialIds is empty', () => {
    const result = routeConnection('api.fal.ai', 443, [], new Map());
    expect(result).toEqual<RouteDecision>({
      action: 'tunnel',
      reason: 'tunnel:no_credentials',
    });
  });

  test('returns tunnel:no_credentials even when templates exist but no ids provided', () => {
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-1', [headerTemplate('*.fal.ai')]],
    ]);
    const result = routeConnection('api.fal.ai', 443, [], templates);
    expect(result).toEqual<RouteDecision>({
      action: 'tunnel',
      reason: 'tunnel:no_credentials',
    });
  });

  // -- tunnel:no_rewrite -----------------------------------------------------

  test('returns tunnel:no_rewrite when no template matches the hostname', () => {
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-1', [headerTemplate('*.openai.com')]],
    ]);
    const result = routeConnection('api.fal.ai', 443, ['cred-1'], templates);
    expect(result).toEqual<RouteDecision>({
      action: 'tunnel',
      reason: 'tunnel:no_rewrite',
    });
  });

  test('returns tunnel:no_rewrite when credential id has no templates', () => {
    const result = routeConnection('api.fal.ai', 443, ['cred-unknown'], new Map());
    expect(result).toEqual<RouteDecision>({
      action: 'tunnel',
      reason: 'tunnel:no_rewrite',
    });
  });

  test('returns tunnel:no_rewrite for bare domain when pattern requires subdomain', () => {
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-1', [headerTemplate('*.fal.ai')]],
    ]);
    // minimatch: "*.fal.ai" does not match bare "fal.ai"
    const result = routeConnection('fal.ai', 443, ['cred-1'], templates);
    expect(result).toEqual<RouteDecision>({
      action: 'tunnel',
      reason: 'tunnel:no_rewrite',
    });
  });

  // -- mitm:credential_injection ---------------------------------------------

  test('returns mitm:credential_injection when a header template matches', () => {
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-fal', [headerTemplate('*.fal.ai')]],
    ]);
    const result = routeConnection('api.fal.ai', 443, ['cred-fal'], templates);
    expect(result).toEqual<RouteDecision>({
      action: 'mitm',
      reason: 'mitm:credential_injection',
    });
  });

  test('returns mitm:credential_injection when a query template matches', () => {
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-gcp', [queryTemplate('maps.googleapis.com', 'key')]],
    ]);
    const result = routeConnection('maps.googleapis.com', 443, ['cred-gcp'], templates);
    expect(result).toEqual<RouteDecision>({
      action: 'mitm',
      reason: 'mitm:credential_injection',
    });
  });

  test('returns mitm:credential_injection with exact hostname match', () => {
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-rep', [headerTemplate('api.replicate.com', 'Authorization', 'Token ')]],
    ]);
    const result = routeConnection('api.replicate.com', 443, ['cred-rep'], templates);
    expect(result).toEqual<RouteDecision>({
      action: 'mitm',
      reason: 'mitm:credential_injection',
    });
  });

  test('returns mitm when any credential matches, even if others do not', () => {
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-openai', [headerTemplate('*.openai.com')]],
      ['cred-fal', [headerTemplate('*.fal.ai')]],
    ]);
    const result = routeConnection('api.fal.ai', 443, ['cred-openai', 'cred-fal'], templates);
    expect(result).toEqual<RouteDecision>({
      action: 'mitm',
      reason: 'mitm:credential_injection',
    });
  });

  test('matches hostnames case-insensitively', () => {
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-fal', [headerTemplate('*.fal.ai')]],
    ]);
    const result = routeConnection('API.FAL.AI', 443, ['cred-fal'], templates);
    expect(result).toEqual<RouteDecision>({
      action: 'mitm',
      reason: 'mitm:credential_injection',
    });
  });

  test('returns mitm when one credential has multiple templates and one matches', () => {
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-multi', [headerTemplate('*.openai.com'), headerTemplate('*.fal.ai')]],
    ]);
    const result = routeConnection('api.fal.ai', 443, ['cred-multi'], templates);
    expect(result).toEqual<RouteDecision>({
      action: 'mitm',
      reason: 'mitm:credential_injection',
    });
  });

  // -- port is passed through but does not affect decision -------------------

  test('port does not affect routing decision', () => {
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-fal', [headerTemplate('*.fal.ai')]],
    ]);
    const on443 = routeConnection('api.fal.ai', 443, ['cred-fal'], templates);
    const on8443 = routeConnection('api.fal.ai', 8443, ['cred-fal'], templates);
    expect(on443).toEqual(on8443);
  });

  // -- only authorized credential ids are considered -------------------------

  test('ignores credentials not in the credentialIds list', () => {
    const templates = new Map<string, CredentialInjectionTemplate[]>([
      ['cred-a', [headerTemplate('*.fal.ai')]],
      ['cred-b', [headerTemplate('*.openai.com')]],
    ]);
    // Only cred-b is authorized, but the host is fal.ai (matches cred-a only)
    const result = routeConnection('api.fal.ai', 443, ['cred-b'], templates);
    expect(result).toEqual<RouteDecision>({
      action: 'tunnel',
      reason: 'tunnel:no_rewrite',
    });
  });
});
