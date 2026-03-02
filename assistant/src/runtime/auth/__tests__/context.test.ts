import { describe, expect, test } from 'bun:test';

import { buildAuthContext } from '../context.js';
import type { TokenClaims } from '../types.js';

function validClaims(overrides?: Partial<TokenClaims>): TokenClaims {
  return {
    iss: 'vellum-auth',
    aud: 'vellum-daemon',
    sub: 'actor:self:principal-abc',
    scope_profile: 'actor_client_v1',
    exp: Math.floor(Date.now() / 1000) + 300,
    policy_epoch: 1,
    iat: Math.floor(Date.now() / 1000),
    jti: 'test-jti',
    ...overrides,
  };
}

describe('buildAuthContext', () => {
  test('builds context from valid actor claims', () => {
    const result = buildAuthContext(validClaims());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.subject).toBe('actor:self:principal-abc');
      expect(result.context.principalType).toBe('actor');
      expect(result.context.assistantId).toBe('self');
      expect(result.context.actorPrincipalId).toBe('principal-abc');
      expect(result.context.sessionId).toBeUndefined();
      expect(result.context.scopeProfile).toBe('actor_client_v1');
      expect(result.context.policyEpoch).toBe(1);
      expect(result.context.scopes.has('chat.read')).toBe(true);
      expect(result.context.scopes.has('chat.write')).toBe(true);
    }
  });

  test('builds context from valid svc:gateway claims', () => {
    const result = buildAuthContext(validClaims({
      sub: 'svc:gateway:self',
      scope_profile: 'gateway_ingress_v1',
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.principalType).toBe('svc_gateway');
      expect(result.context.assistantId).toBe('self');
      expect(result.context.scopes.has('ingress.write')).toBe(true);
    }
  });

  test('builds context from valid ipc claims', () => {
    const result = buildAuthContext(validClaims({
      sub: 'ipc:self:session-123',
      scope_profile: 'ipc_v1',
    }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.principalType).toBe('ipc');
      expect(result.context.assistantId).toBe('self');
      expect(result.context.sessionId).toBe('session-123');
      expect(result.context.scopes.has('ipc.all')).toBe(true);
    }
  });

  test('fails with invalid sub pattern', () => {
    const result = buildAuthContext(validClaims({ sub: 'bad:format' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('unrecognized');
    }
  });

  test('fails with empty sub', () => {
    const result = buildAuthContext(validClaims({ sub: '' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('empty');
    }
  });

  test('preserves policy epoch from claims', () => {
    const result = buildAuthContext(validClaims({ policy_epoch: 42 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.context.policyEpoch).toBe(42);
    }
  });
});
