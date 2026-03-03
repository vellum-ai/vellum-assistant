/**
 * Tests for A2A assistant channel trust classification.
 *
 * Verifies that:
 * - Messages from the 'assistant' channel are classified as peer_assistant trust
 * - Trust classification is fail-closed (no identity -> unknown, not peer_assistant)
 * - The assistant channel type is recognized by the channel type system
 * - Existing channels are not affected by the addition
 */

import { describe, test, expect } from 'bun:test';
import { resolveActorTrust } from '../../runtime/actor-trust-resolver.js';
import { CHANNEL_IDS, isChannelId, INTERFACE_IDS, isInterfaceId } from '../../channels/types.js';

describe('assistant channel trust classification', () => {
  test('assistant channel with valid actor ID is classified as peer_assistant', () => {
    const result = resolveActorTrust({
      assistantId: 'self',
      sourceChannel: 'assistant',
      conversationExternalId: 'conn-123',
      actorExternalId: 'peer-assistant-001',
    });

    expect(result.trustClass).toBe('peer_assistant');
    expect(result.canonicalSenderId).toBe('peer-assistant-001');
    expect(result.actorMetadata.channel).toBe('assistant');
    expect(result.actorMetadata.trustStatus).toBe('peer_assistant');
  });

  test('assistant channel without actor ID is classified as unknown (fail-closed)', () => {
    const result = resolveActorTrust({
      assistantId: 'self',
      sourceChannel: 'assistant',
      conversationExternalId: 'conn-123',
      actorExternalId: undefined,
    });

    expect(result.trustClass).toBe('unknown');
    expect(result.canonicalSenderId).toBeNull();
    expect(result.denialReason).toBe('no_identity');
  });

  test('assistant channel with empty actor ID is classified as unknown', () => {
    const result = resolveActorTrust({
      assistantId: 'self',
      sourceChannel: 'assistant',
      conversationExternalId: 'conn-123',
      actorExternalId: '   ',
    });

    expect(result.trustClass).toBe('unknown');
    expect(result.canonicalSenderId).toBeNull();
  });

  test('assistant channel does not check guardian bindings', () => {
    const result = resolveActorTrust({
      assistantId: 'self',
      sourceChannel: 'assistant',
      conversationExternalId: 'conn-123',
      actorExternalId: 'peer-assistant-001',
    });

    expect(result.guardianBindingMatch).toBeNull();
    expect(result.guardianPrincipalId).toBeUndefined();
    expect(result.memberRecord).toBeNull();
  });

  test('assistant channel preserves display name', () => {
    const result = resolveActorTrust({
      assistantId: 'self',
      sourceChannel: 'assistant',
      conversationExternalId: 'conn-123',
      actorExternalId: 'peer-assistant-001',
      actorDisplayName: 'Friendly Bot',
    });

    expect(result.actorMetadata.displayName).toBe('Friendly Bot');
    expect(result.actorMetadata.senderDisplayName).toBe('Friendly Bot');
  });

  test('assistant channel preserves username', () => {
    const result = resolveActorTrust({
      assistantId: 'self',
      sourceChannel: 'assistant',
      conversationExternalId: 'conn-123',
      actorExternalId: 'peer-assistant-001',
      actorUsername: 'friendly_bot',
    });

    expect(result.actorMetadata.username).toBe('friendly_bot');
    expect(result.actorMetadata.identifier).toBe('@friendly_bot');
  });
});

describe('assistant channel type in channel ID system', () => {
  test('CHANNEL_IDS includes assistant', () => {
    expect(CHANNEL_IDS).toContain('assistant');
  });

  test('isChannelId recognizes assistant', () => {
    expect(isChannelId('assistant')).toBe(true);
  });

  test('INTERFACE_IDS includes assistant', () => {
    expect(INTERFACE_IDS).toContain('assistant');
  });

  test('isInterfaceId recognizes assistant', () => {
    expect(isInterfaceId('assistant')).toBe(true);
  });
});

describe('existing channels are not affected', () => {
  const existingChannels = ['telegram', 'sms', 'voice', 'vellum', 'whatsapp', 'slack', 'email'] as const;

  for (const channel of existingChannels) {
    test(`${channel} channel is still recognized`, () => {
      expect(isChannelId(channel)).toBe(true);
    });
  }

  test('telegram channel does not resolve as peer_assistant', () => {
    const result = resolveActorTrust({
      assistantId: 'self',
      sourceChannel: 'telegram',
      conversationExternalId: 'chat-123',
      actorExternalId: '55001',
    });

    // Telegram actors without a guardian binding should be 'unknown', not 'peer_assistant'
    expect(result.trustClass).not.toBe('peer_assistant');
  });

  test('sms channel does not resolve as peer_assistant', () => {
    const result = resolveActorTrust({
      assistantId: 'self',
      sourceChannel: 'sms',
      conversationExternalId: '+1234567890',
      actorExternalId: '+1234567890',
    });

    expect(result.trustClass).not.toBe('peer_assistant');
  });
});
