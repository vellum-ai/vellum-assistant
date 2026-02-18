/**
 * Proxy policy engine — matches outbound request targets to credential
 * injection templates and emits deterministic policy decisions.
 */

import { minimatch } from 'minimatch';
import type { CredentialInjectionTemplate } from '../../credentials/policy-types.js';
import type { PolicyDecision } from './types.js';

interface MatchCandidate {
  credentialId: string;
  template: CredentialInjectionTemplate;
}

/**
 * Evaluate an outbound request against credential injection templates.
 *
 * @param hostname  Target hostname (e.g. "api.fal.ai")
 * @param _path     Request path — reserved for future path-level matching
 * @param credentialIds  Credential IDs the session is authorized to use
 * @param templates  Map from credentialId → injection templates
 */
export function evaluateRequest(
  hostname: string,
  _path: string,
  credentialIds: string[],
  templates: Map<string, CredentialInjectionTemplate[]>,
): PolicyDecision {
  if (credentialIds.length === 0) {
    return { kind: 'unauthenticated' };
  }

  const candidates: MatchCandidate[] = [];

  for (const id of credentialIds) {
    const tpls = templates.get(id);
    if (!tpls) continue;

    for (const tpl of tpls) {
      if (minimatch(hostname, tpl.hostPattern)) {
        candidates.push({ credentialId: id, template: tpl });
      }
    }
  }

  if (candidates.length === 0) {
    return { kind: 'missing' };
  }

  if (candidates.length === 1) {
    return {
      kind: 'matched',
      credentialId: candidates[0].credentialId,
      template: candidates[0].template,
    };
  }

  return { kind: 'ambiguous', candidates };
}
