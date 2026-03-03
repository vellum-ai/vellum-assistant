import { describe, test, expect } from 'bun:test';
import { CHANNEL_IDS, isChannelId, parseChannelId, assertChannelId, INTERFACE_IDS, isInterfaceId } from '../channels/types.js';
import type { InboundChannelId, GatewayInboundEvent, AssistantInboundEvent } from '../channels/inbound-event.js';

describe('assistant channel type recognition', () => {
  test('CHANNEL_IDS includes assistant', () => {
    expect(CHANNEL_IDS).toContain('assistant');
  });

  test('isChannelId recognizes assistant', () => {
    expect(isChannelId('assistant')).toBe(true);
  });

  test('parseChannelId parses assistant', () => {
    expect(parseChannelId('assistant')).toBe('assistant');
  });

  test('assertChannelId accepts assistant', () => {
    expect(() => assertChannelId('assistant', 'test')).not.toThrow();
    expect(assertChannelId('assistant', 'test')).toBe('assistant');
  });

  test('INTERFACE_IDS includes assistant', () => {
    expect(INTERFACE_IDS).toContain('assistant');
  });

  test('isInterfaceId recognizes assistant', () => {
    expect(isInterfaceId('assistant')).toBe(true);
  });

  test('existing channels are not affected by the addition', () => {
    const existingChannels = ['telegram', 'sms', 'voice', 'vellum', 'whatsapp', 'slack', 'email'];
    for (const ch of existingChannels) {
      expect(isChannelId(ch)).toBe(true);
      expect(parseChannelId(ch)).toBe(ch);
    }
  });

  test('invalid channel IDs are still rejected', () => {
    expect(isChannelId('invalid')).toBe(false);
    expect(parseChannelId('invalid')).toBeNull();
    expect(() => assertChannelId('invalid', 'test')).toThrow();
  });
});

describe('AssistantInboundEvent type', () => {
  test('can create a valid assistant inbound event', () => {
    const event: AssistantInboundEvent = {
      version: 'v1',
      sourceChannel: 'assistant',
      receivedAt: new Date().toISOString(),
      message: {
        content: 'Hello from peer',
        conversationExternalId: 'conn-123',
        externalMessageId: 'msg-456',
      },
      actor: {
        actorExternalId: 'peer-assistant-id',
        displayName: 'Peer Assistant',
      },
      source: {
        updateId: 'nonce-789',
      },
      raw: {},
    };

    expect(event.sourceChannel).toBe('assistant');
  });

  test('assistant event is part of GatewayInboundEvent union', () => {
    const event: GatewayInboundEvent = {
      version: 'v1',
      sourceChannel: 'assistant',
      receivedAt: new Date().toISOString(),
      message: {
        content: 'test',
        conversationExternalId: 'conn-1',
        externalMessageId: 'msg-1',
      },
      actor: {
        actorExternalId: 'peer-1',
      },
      source: {
        updateId: 'nonce-1',
      },
      raw: {},
    };

    // Type system ensures this compiles — sourceChannel discrimination works
    if (event.sourceChannel === 'assistant') {
      expect(event.sourceChannel).toBe('assistant');
    }
  });
});
