import { describe, expect, test } from 'bun:test';

import {
  A2A_EVENT_NAMES,
  createA2ALifecycleEvent,
  createStructuredRequest,
  createStructuredResponse,
  createTextMessage,
  type A2AConnectionRequestedPayload,
  type A2AEventName,
  type A2AMessageContent,
  type A2AMessageEnvelope,
  type A2AOriginMetadata,
  type A2AThreadMapping,
} from '../a2a-message-schema.js';

import {
  DEFAULT_DEDUP_TTL_MS,
  MAX_DEDUP_ENTRIES,
  MessageDedupStore,
} from '../a2a-message-dedup.js';

// ---------------------------------------------------------------------------
// Message envelope construction
// ---------------------------------------------------------------------------

describe('createTextMessage', () => {
  test('creates a valid text message envelope', () => {
    const msg = createTextMessage({
      connectionId: 'conn-1',
      senderAssistantId: 'assistant-a',
      text: 'Hello from assistant A',
    });

    expect(msg.connectionId).toBe('conn-1');
    expect(msg.senderAssistantId).toBe('assistant-a');
    expect(msg.content.type).toBe('text');
    expect((msg.content as { type: 'text'; text: string }).text).toBe('Hello from assistant A');
    expect(msg.status).toBe('pending');
    expect(msg.messageId).toBeTruthy();
    expect(msg.nonce).toBeTruthy();
    expect(msg.timestamp).toBeGreaterThan(0);
  });

  test('uses provided messageId and nonce when given', () => {
    const msg = createTextMessage({
      connectionId: 'conn-1',
      senderAssistantId: 'assistant-a',
      text: 'test',
      messageId: 'custom-id',
      nonce: 'custom-nonce',
      timestamp: 1700000000000,
    });

    expect(msg.messageId).toBe('custom-id');
    expect(msg.nonce).toBe('custom-nonce');
    expect(msg.timestamp).toBe(1700000000000);
  });

  test('includes delivery metadata when provided', () => {
    const msg = createTextMessage({
      connectionId: 'conn-1',
      senderAssistantId: 'assistant-a',
      text: 'reply',
      delivery: {
        correlationId: 'original-msg-1',
        replyTo: 'msg-0',
      },
    });

    expect(msg.delivery?.correlationId).toBe('original-msg-1');
    expect(msg.delivery?.replyTo).toBe('msg-0');
  });

  test('generates unique messageId and nonce per call', () => {
    const msg1 = createTextMessage({
      connectionId: 'conn-1',
      senderAssistantId: 'a',
      text: 'first',
    });
    const msg2 = createTextMessage({
      connectionId: 'conn-1',
      senderAssistantId: 'a',
      text: 'second',
    });

    expect(msg1.messageId).not.toBe(msg2.messageId);
    expect(msg1.nonce).not.toBe(msg2.nonce);
  });
});

describe('createStructuredRequest', () => {
  test('creates a structured request envelope', () => {
    const msg = createStructuredRequest({
      connectionId: 'conn-2',
      senderAssistantId: 'assistant-b',
      action: 'schedule_meeting',
      requestParams: { date: '2025-01-15', duration: 60 },
    });

    expect(msg.content.type).toBe('structured_request');
    const content = msg.content as { type: 'structured_request'; action: string; params: Record<string, unknown> };
    expect(content.action).toBe('schedule_meeting');
    expect(content.params.date).toBe('2025-01-15');
    expect(content.params.duration).toBe(60);
    expect(msg.status).toBe('pending');
  });
});

describe('createStructuredResponse', () => {
  test('creates a structured response with correlation ID', () => {
    const msg = createStructuredResponse({
      connectionId: 'conn-2',
      senderAssistantId: 'assistant-a',
      action: 'schedule_meeting',
      result: { confirmed: true, eventId: 'evt-123' },
      success: true,
      correlationId: 'request-msg-id',
    });

    expect(msg.content.type).toBe('structured_response');
    const content = msg.content as {
      type: 'structured_response';
      action: string;
      result: Record<string, unknown>;
      success: boolean;
    };
    expect(content.action).toBe('schedule_meeting');
    expect(content.result.confirmed).toBe(true);
    expect(content.success).toBe(true);
    expect(msg.delivery?.correlationId).toBe('request-msg-id');
  });

  test('includes error field on failure', () => {
    const msg = createStructuredResponse({
      connectionId: 'conn-2',
      senderAssistantId: 'assistant-a',
      action: 'schedule_meeting',
      result: {},
      success: false,
      error: 'Calendar unavailable',
      correlationId: 'request-msg-id',
    });

    const content = msg.content as {
      type: 'structured_response';
      success: boolean;
      error?: string;
    };
    expect(content.success).toBe(false);
    expect(content.error).toBe('Calendar unavailable');
  });
});

// ---------------------------------------------------------------------------
// Content type discrimination
// ---------------------------------------------------------------------------

describe('A2AMessageContent type discrimination', () => {
  test('text content has type "text"', () => {
    const content: A2AMessageContent = { type: 'text', text: 'hello' };
    expect(content.type).toBe('text');
  });

  test('structured request has type "structured_request"', () => {
    const content: A2AMessageContent = {
      type: 'structured_request',
      action: 'test',
      params: {},
    };
    expect(content.type).toBe('structured_request');
  });

  test('structured response has type "structured_response"', () => {
    const content: A2AMessageContent = {
      type: 'structured_response',
      action: 'test',
      result: {},
      success: true,
    };
    expect(content.type).toBe('structured_response');
  });
});

// ---------------------------------------------------------------------------
// Thread/conversation mapping types
// ---------------------------------------------------------------------------

describe('Thread mapping types', () => {
  test('A2AThreadMapping shape is valid', () => {
    const mapping: A2AThreadMapping = {
      connectionId: 'conn-1',
      conversationId: 'conv-abc',
      createdAt: Date.now(),
    };

    expect(mapping.connectionId).toBe('conn-1');
    expect(mapping.conversationId).toBe('conv-abc');
    expect(mapping.createdAt).toBeGreaterThan(0);
  });

  test('A2AOriginMetadata carries peer attribution', () => {
    const origin: A2AOriginMetadata = {
      peerAssistantId: 'peer-assistant-1',
      peerGuardianDisplayName: 'Alice',
      peerGatewayUrl: 'https://alice.example.com',
      connectionId: 'conn-1',
    };

    expect(origin.peerAssistantId).toBe('peer-assistant-1');
    expect(origin.peerGuardianDisplayName).toBe('Alice');
    expect(origin.peerGatewayUrl).toBe('https://alice.example.com');
  });

  test('A2AOriginMetadata allows null peer info', () => {
    const origin: A2AOriginMetadata = {
      peerAssistantId: null,
      peerGuardianDisplayName: null,
      peerGatewayUrl: 'https://unknown.example.com',
      connectionId: 'conn-2',
    };

    expect(origin.peerAssistantId).toBeNull();
    expect(origin.peerGuardianDisplayName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle event types
// ---------------------------------------------------------------------------

describe('A2A_EVENT_NAMES', () => {
  test('contains all expected lifecycle events', () => {
    expect(A2A_EVENT_NAMES.CONNECTION_REQUESTED).toBe('a2a.connection_requested');
    expect(A2A_EVENT_NAMES.CONNECTION_APPROVED).toBe('a2a.connection_approved');
    expect(A2A_EVENT_NAMES.CONNECTION_DENIED).toBe('a2a.connection_denied');
    expect(A2A_EVENT_NAMES.VERIFICATION_CODE_READY).toBe('a2a.verification_code_ready');
    expect(A2A_EVENT_NAMES.CONNECTION_ESTABLISHED).toBe('a2a.connection_established');
    expect(A2A_EVENT_NAMES.CONNECTION_REVOKED).toBe('a2a.connection_revoked');
    expect(A2A_EVENT_NAMES.MESSAGE_RECEIVED).toBe('a2a.message_received');
    expect(A2A_EVENT_NAMES.MESSAGE_DELIVERED).toBe('a2a.message_delivered');
    expect(A2A_EVENT_NAMES.MESSAGE_FAILED).toBe('a2a.message_failed');
  });

  test('all event names start with "a2a."', () => {
    for (const name of Object.values(A2A_EVENT_NAMES)) {
      expect(name.startsWith('a2a.')).toBe(true);
    }
  });
});

describe('createA2ALifecycleEvent', () => {
  test('creates a typed connection_requested event', () => {
    const payload: A2AConnectionRequestedPayload = {
      connectionId: 'conn-1',
      peerGatewayUrl: 'https://peer.example.com',
      peerAssistantId: 'peer-1',
      protocolVersion: '1.0.0',
      capabilities: ['messaging'],
    };

    const event = createA2ALifecycleEvent(
      A2A_EVENT_NAMES.CONNECTION_REQUESTED,
      payload,
    );

    expect(event.eventName).toBe('a2a.connection_requested');
    expect(event.payload.connectionId).toBe('conn-1');
    expect(event.payload.peerGatewayUrl).toBe('https://peer.example.com');
    expect(event.payload.capabilities).toEqual(['messaging']);
    expect(event.timestamp).toBeGreaterThan(0);
  });

  test('uses provided timestamp when given', () => {
    const event = createA2ALifecycleEvent(
      A2A_EVENT_NAMES.CONNECTION_ESTABLISHED,
      {
        connectionId: 'conn-1',
        peerGatewayUrl: 'https://peer.example.com',
        peerAssistantId: null,
        status: 'active',
      },
      1700000000000,
    );

    expect(event.timestamp).toBe(1700000000000);
  });

  test('creates a message_received event with content type', () => {
    const event = createA2ALifecycleEvent(
      A2A_EVENT_NAMES.MESSAGE_RECEIVED,
      {
        connectionId: 'conn-1',
        messageId: 'msg-1',
        senderAssistantId: 'peer-1',
        contentType: 'text',
        conversationId: 'conv-abc',
      },
    );

    expect(event.eventName).toBe('a2a.message_received');
    expect(event.payload.contentType).toBe('text');
    expect(event.payload.conversationId).toBe('conv-abc');
  });

  test('creates a message_failed event with error', () => {
    const event = createA2ALifecycleEvent(
      A2A_EVENT_NAMES.MESSAGE_FAILED,
      {
        connectionId: 'conn-1',
        messageId: 'msg-2',
        error: 'Connection timeout',
      },
    );

    expect(event.eventName).toBe('a2a.message_failed');
    expect(event.payload.error).toBe('Connection timeout');
  });

  test('creates a verification_code_ready event', () => {
    const event = createA2ALifecycleEvent(
      A2A_EVENT_NAMES.VERIFICATION_CODE_READY,
      {
        connectionId: 'conn-1',
        verificationCode: '123456',
        peerGatewayUrl: 'https://peer.example.com',
        peerAssistantId: null,
      },
    );

    expect(event.eventName).toBe('a2a.verification_code_ready');
    expect(event.payload.verificationCode).toBe('123456');
  });
});

// ---------------------------------------------------------------------------
// MessageDedupStore
// ---------------------------------------------------------------------------

describe('MessageDedupStore', () => {
  test('first message is not a duplicate', () => {
    const store = new MessageDedupStore();
    expect(store.isDuplicate('conn-1', 'nonce-a')).toBe(false);
  });

  test('same (connectionId, nonce) on second call is a duplicate', () => {
    const store = new MessageDedupStore();
    expect(store.isDuplicate('conn-1', 'nonce-a')).toBe(false);
    expect(store.isDuplicate('conn-1', 'nonce-a')).toBe(true);
  });

  test('same nonce on different connections is not a duplicate', () => {
    const store = new MessageDedupStore();
    expect(store.isDuplicate('conn-1', 'nonce-a')).toBe(false);
    expect(store.isDuplicate('conn-2', 'nonce-a')).toBe(false);
  });

  test('different nonces on same connection are not duplicates', () => {
    const store = new MessageDedupStore();
    expect(store.isDuplicate('conn-1', 'nonce-a')).toBe(false);
    expect(store.isDuplicate('conn-1', 'nonce-b')).toBe(false);
  });

  test('isKnown returns true for recorded pairs without recording', () => {
    const store = new MessageDedupStore();
    store.record('conn-1', 'nonce-a');
    expect(store.isKnown('conn-1', 'nonce-a')).toBe(true);
    expect(store.isKnown('conn-1', 'nonce-b')).toBe(false);
  });

  test('record explicitly adds a pair', () => {
    const store = new MessageDedupStore();
    store.record('conn-1', 'nonce-a');
    expect(store.isDuplicate('conn-1', 'nonce-a')).toBe(true);
    expect(store.size).toBe(1);
  });

  test('size tracks the number of entries', () => {
    const store = new MessageDedupStore();
    expect(store.size).toBe(0);

    store.isDuplicate('conn-1', 'nonce-1');
    expect(store.size).toBe(1);

    store.isDuplicate('conn-1', 'nonce-2');
    expect(store.size).toBe(2);

    // Duplicate does not increase size
    store.isDuplicate('conn-1', 'nonce-1');
    expect(store.size).toBe(2);
  });

  test('clear resets the store', () => {
    const store = new MessageDedupStore();
    store.isDuplicate('conn-1', 'nonce-1');
    store.isDuplicate('conn-1', 'nonce-2');
    expect(store.size).toBe(2);

    store.clear();
    expect(store.size).toBe(0);
    expect(store.isDuplicate('conn-1', 'nonce-1')).toBe(false);
  });

  // -- TTL-based eviction --

  test('entries expire after TTL', () => {
    const ttl = 1000; // 1 second for testing
    const store = new MessageDedupStore(ttl);

    const t0 = 1000000;
    store.isDuplicate('conn-1', 'nonce-a', t0);
    expect(store.isDuplicate('conn-1', 'nonce-a', t0 + 500)).toBe(true);

    // After TTL passes, a sweep should evict the entry
    store.sweep(t0 + ttl + 1);
    expect(store.isDuplicate('conn-1', 'nonce-a', t0 + ttl + 2)).toBe(false);
  });

  test('sweep evicts only expired entries', () => {
    const ttl = 1000;
    const store = new MessageDedupStore(ttl);

    const t0 = 1000000;
    store.isDuplicate('conn-1', 'nonce-old', t0);
    store.isDuplicate('conn-1', 'nonce-new', t0 + 800);

    const evicted = store.sweep(t0 + ttl + 1);
    expect(evicted).toBe(1);
    expect(store.size).toBe(1);
    expect(store.isKnown('conn-1', 'nonce-old', t0 + ttl + 1)).toBe(false);
    expect(store.isKnown('conn-1', 'nonce-new', t0 + ttl + 1)).toBe(true);
  });

  test('opportunistic sweep triggers on isDuplicate after TTL interval', () => {
    const ttl = 1000;
    const store = new MessageDedupStore(ttl);

    const t0 = 1000000;
    store.isDuplicate('conn-1', 'nonce-a', t0);
    expect(store.size).toBe(1);

    // This call should trigger an opportunistic sweep because
    // currentTime - lastSweep >= ttlMs
    store.isDuplicate('conn-1', 'nonce-b', t0 + ttl + 1);
    // nonce-a should have been evicted, nonce-b is new
    expect(store.isKnown('conn-1', 'nonce-a', t0 + ttl + 1)).toBe(false);
    expect(store.size).toBe(1);
  });

  test('default TTL is 10 minutes', () => {
    expect(DEFAULT_DEDUP_TTL_MS).toBe(10 * 60 * 1000);
  });

  test('MAX_DEDUP_ENTRIES is 10000', () => {
    expect(MAX_DEDUP_ENTRIES).toBe(10_000);
  });
});
