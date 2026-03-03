import { describe, test, expect } from 'bun:test';
import { normalizeA2AInbound, type A2AInboundEnvelope } from '../a2a/normalize.js';

describe('normalizeA2AInbound', () => {
  const validEnvelope: A2AInboundEnvelope = {
    messageId: 'msg-001',
    connectionId: 'conn-abc',
    senderAssistantId: 'peer-assistant-1',
    nonce: 'nonce-xyz',
    timestamp: 1700000000000,
    content: {
      type: 'text',
      text: 'Hello from peer assistant',
    },
    status: 'pending',
  };

  test('normalizes a valid text message into GatewayInboundEvent', () => {
    const result = normalizeA2AInbound(validEnvelope);

    expect(result).not.toBeNull();
    expect(result!.version).toBe('v1');
    expect(result!.sourceChannel).toBe('assistant');
    expect(result!.message.content).toBe('Hello from peer assistant');
    expect(result!.message.conversationExternalId).toBe('conn-abc');
    expect(result!.message.externalMessageId).toBe('msg-001');
    expect(result!.actor.actorExternalId).toBe('peer-assistant-1');
    expect(result!.actor.displayName).toBe('peer-assistant-1');
    expect(result!.source.updateId).toBe('nonce-xyz');
    expect(result!.source.messageId).toBe('msg-001');
    expect(result!.raw).toEqual(validEnvelope as unknown as Record<string, unknown>);
  });

  test('normalizes a structured request message', () => {
    const envelope: A2AInboundEnvelope = {
      ...validEnvelope,
      content: {
        type: 'structured_request',
        action: 'search',
        params: { query: 'test' },
      },
    };

    const result = normalizeA2AInbound(envelope);

    expect(result).not.toBeNull();
    expect(result!.sourceChannel).toBe('assistant');
    const parsed = JSON.parse(result!.message.content);
    expect(parsed.type).toBe('structured_request');
    expect(parsed.action).toBe('search');
    expect(parsed.params).toEqual({ query: 'test' });
  });

  test('normalizes a structured response message', () => {
    const envelope: A2AInboundEnvelope = {
      ...validEnvelope,
      content: {
        type: 'structured_response',
        action: 'search',
        result: { items: [] },
        success: true,
      },
    };

    const result = normalizeA2AInbound(envelope);

    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!.message.content);
    expect(parsed.type).toBe('structured_response');
    expect(parsed.action).toBe('search');
    expect(parsed.success).toBe(true);
  });

  test('returns null when messageId is missing', () => {
    const envelope = { ...validEnvelope, messageId: '' };
    expect(normalizeA2AInbound(envelope)).toBeNull();
  });

  test('returns null when connectionId is missing', () => {
    const envelope = { ...validEnvelope, connectionId: '' };
    expect(normalizeA2AInbound(envelope)).toBeNull();
  });

  test('returns null when senderAssistantId is missing', () => {
    const envelope = { ...validEnvelope, senderAssistantId: '' };
    expect(normalizeA2AInbound(envelope)).toBeNull();
  });

  test('returns null when content is missing', () => {
    const envelope = { ...validEnvelope, content: undefined as unknown as A2AInboundEnvelope['content'] };
    expect(normalizeA2AInbound(envelope)).toBeNull();
  });

  test('maps conversationExternalId to connectionId', () => {
    const result = normalizeA2AInbound(validEnvelope);
    expect(result).not.toBeNull();
    expect(result!.message.conversationExternalId).toBe(validEnvelope.connectionId);
  });

  test('maps actorExternalId to senderAssistantId', () => {
    const result = normalizeA2AInbound(validEnvelope);
    expect(result).not.toBeNull();
    expect(result!.actor.actorExternalId).toBe(validEnvelope.senderAssistantId);
  });

  test('handles unknown content type gracefully', () => {
    const envelope: A2AInboundEnvelope = {
      ...validEnvelope,
      content: { type: 'unknown_type' as string },
    };

    const result = normalizeA2AInbound(envelope);
    expect(result).not.toBeNull();
    expect(result!.message.content).toBe('');
  });
});
