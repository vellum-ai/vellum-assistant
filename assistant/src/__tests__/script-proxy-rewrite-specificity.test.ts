import { describe, test, expect } from 'bun:test';
import {
  matchHostPattern,
  compareMatchSpecificity,
  type HostMatchKind,
} from '../tools/credentials/host-pattern-match.js';
import type { CredentialInjectionTemplate } from '../tools/credentials/policy-types.js';

/**
 * Extracted rewrite candidate selection logic — mirrors what session-manager's
 * rewriteCallback does internally. This allows testing the selection algorithm
 * without standing up a full MITM proxy server.
 */
function selectRewriteCandidate(
  hostname: string,
  templates: Map<string, CredentialInjectionTemplate[]>,
): { credId: string; tpl: CredentialInjectionTemplate } | 'ambiguous' | 'none' {
  const perCredentialBest: { credId: string; tpl: CredentialInjectionTemplate }[] = [];

  for (const [credId, tpls] of templates) {
    let bestMatch: HostMatchKind = 'none';
    let bestCandidates: CredentialInjectionTemplate[] = [];

    for (const tpl of tpls) {
      if (tpl.injectionType === 'query') continue;
      const match = matchHostPattern(hostname, tpl.hostPattern, { includeApexForWildcard: true });
      if (match === 'none') continue;

      const cmp = compareMatchSpecificity(match, bestMatch);
      if (cmp < 0) {
        bestMatch = match;
        bestCandidates = [tpl];
      } else if (cmp === 0) {
        bestCandidates.push(tpl);
      }
    }

    if (bestCandidates.length === 1) {
      perCredentialBest.push({ credId, tpl: bestCandidates[0] });
    } else if (bestCandidates.length > 1) {
      return 'ambiguous';
    }
  }

  if (perCredentialBest.length === 0) return 'none';
  if (perCredentialBest.length > 1) return 'ambiguous';
  return perCredentialBest[0];
}

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

describe('MITM rewrite candidate selection (specificity-aligned)', () => {
  test('one credential with fal.run + *.fal.run injects exact once', () => {
    const templates = new Map([
      ['cred-fal', [
        headerTemplate('fal.run', 'Authorization', 'Key '),
        headerTemplate('*.fal.run', 'Authorization', 'Key '),
      ]],
    ]);
    const result = selectRewriteCandidate('fal.run', templates);
    expect(result).not.toBe('ambiguous');
    expect(result).not.toBe('none');
    if (typeof result === 'object') {
      expect(result.credId).toBe('cred-fal');
      expect(result.tpl.hostPattern).toBe('fal.run');
    }
  });

  test('one credential with only wildcard matches bare domain via apex inclusion', () => {
    const templates = new Map([
      ['cred-fal', [headerTemplate('*.fal.run')]],
    ]);
    const result = selectRewriteCandidate('fal.run', templates);
    expect(result).not.toBe('ambiguous');
    expect(result).not.toBe('none');
    if (typeof result === 'object') {
      expect(result.credId).toBe('cred-fal');
    }
  });

  test('two credentials matching same host still blocks (ambiguous)', () => {
    const templates = new Map([
      ['cred-a', [headerTemplate('*.fal.run', 'Authorization')]],
      ['cred-b', [headerTemplate('*.fal.run', 'X-Api-Key')]],
    ]);
    const result = selectRewriteCandidate('api.fal.run', templates);
    expect(result).toBe('ambiguous');
  });

  test('no match returns none', () => {
    const templates = new Map([
      ['cred-openai', [headerTemplate('*.openai.com')]],
    ]);
    const result = selectRewriteCandidate('api.fal.run', templates);
    expect(result).toBe('none');
  });

  test('query templates are excluded from candidate selection', () => {
    const templates = new Map([
      ['cred-gcp', [
        queryTemplate('maps.googleapis.com', 'key'),
        headerTemplate('maps.googleapis.com'),
      ]],
    ]);
    const result = selectRewriteCandidate('maps.googleapis.com', templates);
    expect(result).not.toBe('ambiguous');
    if (typeof result === 'object') {
      expect(result.tpl.injectionType).toBe('header');
    }
  });

  test('same credential equal-specificity tie returns ambiguous', () => {
    const templates = new Map([
      ['cred-dual', [
        headerTemplate('api.fal.run', 'Authorization', 'Key '),
        headerTemplate('api.fal.run', 'X-Api-Key', 'Bearer '),
      ]],
    ]);
    const result = selectRewriteCandidate('api.fal.run', templates);
    expect(result).toBe('ambiguous');
  });
});
