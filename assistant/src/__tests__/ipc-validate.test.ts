import { describe, test, expect } from 'bun:test';
import { validateClientMessage, isClientMessageEnvelope } from '../daemon/ipc-validate.js';
import { extractInventory } from '../daemon/ipc-contract-inventory.js';

describe('IPC Validate', () => {
  describe('validateClientMessage', () => {
    // ─── Envelope checks ───────────────────────────────────────────────

    test('rejects null', () => {
      const result = validateClientMessage(null);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('not a JSON object');
    });

    test('rejects undefined', () => {
      const result = validateClientMessage(undefined);
      expect(result.valid).toBe(false);
    });

    test('rejects arrays', () => {
      const result = validateClientMessage([{ type: 'ping' }]);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('not a JSON object');
    });

    test('rejects primitives', () => {
      expect(validateClientMessage('ping').valid).toBe(false);
      expect(validateClientMessage(42).valid).toBe(false);
      expect(validateClientMessage(true).valid).toBe(false);
    });

    test('rejects object without type field', () => {
      const result = validateClientMessage({ sessionId: 'abc' });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('missing a string "type" field');
    });

    test('rejects object with non-string type', () => {
      const result = validateClientMessage({ type: 42 });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('missing a string "type" field');
    });

    test('rejects unknown message type', () => {
      const result = validateClientMessage({ type: 'not_a_real_type' });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('Unknown message type');
    });

    // ─── Valid simple messages ──────────────────────────────────────────

    test('accepts ping', () => {
      const result = validateClientMessage({ type: 'ping' });
      expect(result.valid).toBe(true);
      if (result.valid) expect(result.message).toEqual({ type: 'ping' });
    });

    test('accepts session_list', () => {
      const result = validateClientMessage({ type: 'session_list' });
      expect(result.valid).toBe(true);
    });

    test('accepts cancel', () => {
      const result = validateClientMessage({ type: 'cancel', sessionId: 'abc' });
      expect(result.valid).toBe(true);
    });

    test('accepts model_get', () => {
      const result = validateClientMessage({ type: 'model_get' });
      expect(result.valid).toBe(true);
    });

    test('accepts sessions_clear', () => {
      const result = validateClientMessage({ type: 'sessions_clear' });
      expect(result.valid).toBe(true);
    });

    // ─── High-risk: user_message ────────────────────────────────────────

    test('accepts valid user_message', () => {
      const result = validateClientMessage({
        type: 'user_message',
        sessionId: 'session-1',
        content: 'Hello',
      });
      expect(result.valid).toBe(true);
    });

    test('accepts user_message with attachments', () => {
      const result = validateClientMessage({
        type: 'user_message',
        sessionId: 'session-1',
        attachments: [{ filename: 'f.txt', mimeType: 'text/plain', data: 'abc' }],
      });
      expect(result.valid).toBe(true);
    });

    test('rejects user_message without sessionId', () => {
      const result = validateClientMessage({ type: 'user_message', content: 'Hello' });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('non-empty string "sessionId"');
    });

    test('rejects user_message with empty sessionId', () => {
      const result = validateClientMessage({ type: 'user_message', sessionId: '', content: 'Hi' });
      expect(result.valid).toBe(false);
    });

    test('rejects user_message with non-string content', () => {
      const result = validateClientMessage({
        type: 'user_message',
        sessionId: 'session-1',
        content: 42,
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('"content" must be a string');
    });

    test('rejects user_message with non-array attachments', () => {
      const result = validateClientMessage({
        type: 'user_message',
        sessionId: 'session-1',
        attachments: 'not-an-array',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('"attachments" must be an array');
    });

    // ─── High-risk: session_create ──────────────────────────────────────

    test('accepts valid session_create', () => {
      const result = validateClientMessage({ type: 'session_create' });
      expect(result.valid).toBe(true);
    });

    test('accepts session_create with optional fields', () => {
      const result = validateClientMessage({
        type: 'session_create',
        title: 'My Session',
        maxResponseTokens: 4096,
      });
      expect(result.valid).toBe(true);
    });

    test('rejects session_create with non-string title', () => {
      const result = validateClientMessage({ type: 'session_create', title: 42 });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('"title" must be a string');
    });

    test('rejects session_create with non-number maxResponseTokens', () => {
      const result = validateClientMessage({
        type: 'session_create',
        maxResponseTokens: 'big',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('"maxResponseTokens" must be a number');
    });

    // ─── High-risk: confirmation_response ───────────────────────────────

    test('accepts valid confirmation_response', () => {
      const result = validateClientMessage({
        type: 'confirmation_response',
        requestId: 'req-1',
        decision: 'allow',
      });
      expect(result.valid).toBe(true);
    });

    test('accepts all valid decision values', () => {
      for (const decision of ['allow', 'always_allow', 'always_allow_high_risk', 'deny', 'always_deny']) {
        const result = validateClientMessage({
          type: 'confirmation_response',
          requestId: 'req-1',
          decision,
        });
        expect(result.valid).toBe(true);
      }
    });

    test('accepts always_allow_high_risk decision', () => {
      const result = validateClientMessage({
        type: 'confirmation_response',
        requestId: 'req-1',
        decision: 'always_allow_high_risk',
        selectedPattern: 'Bash(*)',
        selectedScope: 'global',
      });
      expect(result.valid).toBe(true);
      if (result.valid) {
        const msg = result.message as { decision: string; selectedPattern?: string; selectedScope?: string };
        expect(msg.decision).toBe('always_allow_high_risk');
        expect(msg.selectedPattern).toBe('Bash(*)');
        expect(msg.selectedScope).toBe('global');
      }
    });

    test('rejects confirmation_response without requestId', () => {
      const result = validateClientMessage({
        type: 'confirmation_response',
        decision: 'allow',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('non-empty string "requestId"');
    });

    test('rejects confirmation_response with invalid decision', () => {
      const result = validateClientMessage({
        type: 'confirmation_response',
        requestId: 'req-1',
        decision: 'maybe',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('"decision" must be one of');
    });

    // ─── High-risk: secret_response ─────────────────────────────────────

    test('accepts valid secret_response with value', () => {
      const result = validateClientMessage({
        type: 'secret_response',
        requestId: 'req-1',
        value: 'my-secret',
      });
      expect(result.valid).toBe(true);
    });

    test('accepts secret_response without value (cancelled)', () => {
      const result = validateClientMessage({
        type: 'secret_response',
        requestId: 'req-1',
      });
      expect(result.valid).toBe(true);
    });

    test('rejects secret_response without requestId', () => {
      const result = validateClientMessage({
        type: 'secret_response',
        value: 'my-secret',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('non-empty string "requestId"');
    });

    test('rejects secret_response with non-string value', () => {
      const result = validateClientMessage({
        type: 'secret_response',
        requestId: 'req-1',
        value: 42,
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('"value" must be a string');
    });

    // ─── High-risk: ui_surface_action ───────────────────────────────────

    test('accepts valid ui_surface_action', () => {
      const result = validateClientMessage({
        type: 'ui_surface_action',
        sessionId: 'session-1',
        surfaceId: 'surface-1',
        actionId: 'action-1',
      });
      expect(result.valid).toBe(true);
    });

    test('rejects ui_surface_action without sessionId', () => {
      const result = validateClientMessage({
        type: 'ui_surface_action',
        surfaceId: 'surface-1',
        actionId: 'action-1',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('non-empty string "sessionId"');
    });

    test('rejects ui_surface_action without surfaceId', () => {
      const result = validateClientMessage({
        type: 'ui_surface_action',
        sessionId: 'session-1',
        actionId: 'action-1',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('non-empty string "surfaceId"');
    });

    test('rejects ui_surface_action without actionId', () => {
      const result = validateClientMessage({
        type: 'ui_surface_action',
        sessionId: 'session-1',
        surfaceId: 'surface-1',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('non-empty string "actionId"');
    });

    // ─── High-risk: add_trust_rule ──────────────────────────────────────

    test('accepts valid add_trust_rule', () => {
      const result = validateClientMessage({
        type: 'add_trust_rule',
        toolName: 'Bash',
        pattern: '*',
        scope: 'global',
        decision: 'allow',
      });
      expect(result.valid).toBe(true);
    });

    test('accepts all valid add_trust_rule decisions', () => {
      for (const decision of ['allow', 'deny', 'ask']) {
        const result = validateClientMessage({
          type: 'add_trust_rule',
          toolName: 'Bash',
          pattern: '*',
          scope: 'global',
          decision,
        });
        expect(result.valid).toBe(true);
      }
    });

    test('rejects add_trust_rule without toolName', () => {
      const result = validateClientMessage({
        type: 'add_trust_rule',
        pattern: '*',
        scope: 'global',
        decision: 'allow',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('non-empty string "toolName"');
    });

    test('rejects add_trust_rule with invalid decision', () => {
      const result = validateClientMessage({
        type: 'add_trust_rule',
        toolName: 'Bash',
        pattern: '*',
        scope: 'global',
        decision: 'always_allow',
      });
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.reason).toContain('"decision" must be one of');
    });

    // ─── Extra properties are tolerated ─────────────────────────────────

    test('allows extra properties on known types', () => {
      const result = validateClientMessage({
        type: 'ping',
        extraField: 'ignored',
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('isClientMessageEnvelope', () => {
    test('returns true for valid messages', () => {
      expect(isClientMessageEnvelope({ type: 'ping' })).toBe(true);
    });

    test('returns false for invalid messages', () => {
      expect(isClientMessageEnvelope(null)).toBe(false);
      expect(isClientMessageEnvelope({ type: 'bogus' })).toBe(false);
      expect(isClientMessageEnvelope(42)).toBe(false);
    });

    test('narrows type to ClientMessage', () => {
      const val: unknown = { type: 'ping' };
      if (isClientMessageEnvelope(val)) {
        // TypeScript narrows val to ClientMessage — access .type safely
        expect(val.type).toBe('ping');
      }
    });
  });

  describe('contract parity', () => {
    // Minimal valid payloads for high-risk message types that require extra fields
    const HIGH_RISK_FIXTURES: Record<string, Record<string, unknown>> = {
      auth: { token: 'abc123' },
      user_message: { sessionId: 's1', content: 'hi' },
      confirmation_response: { requestId: 'r1', decision: 'allow' },
      secret_response: { requestId: 'r1' },
      ui_surface_action: { sessionId: 's1', surfaceId: 'sf1', actionId: 'a1' },
      ipc_blob_probe: { probeId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', nonceSha256: 'abc123' },
      add_trust_rule: { toolName: 'Bash', pattern: '*', scope: 'global', decision: 'allow' },
      document_save: { surfaceId: 'doc1', conversationId: 'c1', title: 'Doc', content: 'text', wordCount: 1 },
      document_load: { surfaceId: 'doc1' },
      document_list: {},
    };

    test('KNOWN_CLIENT_TYPES matches live contract wire types', () => {
      const live = extractInventory();
      for (const wireType of live.clientWireTypes) {
        const payload = { type: wireType, ...HIGH_RISK_FIXTURES[wireType] };
        const result = validateClientMessage(payload);
        expect(result.valid).toBe(true);
      }
    });

    test('validator rejects types not in the live contract', () => {
      const result = validateClientMessage({ type: 'fabricated_type_not_in_contract' });
      expect(result.valid).toBe(false);
    });
  });
});
