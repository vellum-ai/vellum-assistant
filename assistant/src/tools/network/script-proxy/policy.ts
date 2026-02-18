/**
 * Proxy policy engine — matches outbound request targets to credential
 * injection templates and emits deterministic policy decisions.
 */

import { minimatch } from 'minimatch';
import type { CredentialInjectionTemplate } from '../../credentials/policy-types.js';
import type { PolicyDecision, RequestTargetContext } from './types.js';

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
      // Query templates are handled via URL rewriting in the MITM path
      // and can't be injected by the HTTP forwarder. Exclude them so
      // a host with both query and header templates doesn't appear
      // ambiguous — consistent with the MITM rewriteCallback filtering.
      if (tpl.injectionType === 'query') continue;
      if (minimatch(hostname, tpl.hostPattern, { nocase: true })) {
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

/**
 * Evaluate an outbound request with approval-hook awareness.
 *
 * This wraps `evaluateRequest` and, when the base decision is `missing` or
 * `unauthenticated`, consults the full credential template registry to
 * determine whether an approval prompt should be surfaced:
 *
 * - `ask_missing_credential` — the target host matches at least one known
 *   template pattern in the registry, but the session has no credential
 *   bound for it.
 * - `ask_unauthenticated` — the request doesn't match any known template
 *   in the full registry and the session has no credentials.
 *
 * For `matched` and `ambiguous` decisions the result passes through unchanged.
 *
 * @param hostname       Target hostname
 * @param port           Target port (null when the default for the scheme)
 * @param path           Request path
 * @param credentialIds  Credential IDs the session is authorized to use
 * @param sessionTemplates  Templates for the session's credential IDs
 * @param allKnownTemplates All credential injection templates across every
 *                          credential in the system — used to detect whether
 *                          the target host is "known" even if the session
 *                          doesn't have the right credential bound.
 */
export function evaluateRequestWithApproval(
  hostname: string,
  port: number | null,
  path: string,
  credentialIds: string[],
  sessionTemplates: Map<string, CredentialInjectionTemplate[]>,
  allKnownTemplates: CredentialInjectionTemplate[],
  scheme: 'http' | 'https' = 'https',
): PolicyDecision {
  const base = evaluateRequest(hostname, path, credentialIds, sessionTemplates);

  if (base.kind !== 'missing' && base.kind !== 'unauthenticated') {
    return base;
  }

  const target: RequestTargetContext = { hostname, port, path, scheme };

  // Check whether any template in the full registry covers this host.
  const matchingPatterns: string[] = [];
  for (const tpl of allKnownTemplates) {
    if (minimatch(hostname, tpl.hostPattern, { nocase: true })) {
      matchingPatterns.push(tpl.hostPattern);
    }
  }
  // Deduplicate — multiple credentials may share the same host pattern.
  const uniquePatterns = [...new Set(matchingPatterns)];

  if (uniquePatterns.length > 0) {
    // A known host pattern exists but no credential is bound to this session.
    return { kind: 'ask_missing_credential', target, matchingPatterns: uniquePatterns };
  }

  // Completely unknown host — prompt for unauthenticated access.
  return { kind: 'ask_unauthenticated', target };
}
