import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { RuntimeAttachmentMetadata } from '../runtime/http-types.js';

type DeliveryCall = {
  callbackUrl: string;
  payload: Record<string, unknown>;
  bearerToken?: string;
};

const deliveryCalls: DeliveryCall[] = [];
const conversationMessages: Array<{ id: string; role: string; content: string }> = [];
const attachmentsByMessageId = new Map<string, Array<{
  id: string;
  originalFilename?: string;
  mimeType?: string;
  sizeBytes?: number;
  kind?: string;
}>>();

let renderedHistoryContent: {
  text: string;
  textSegments: string[];
  toolCalls: unknown[];
  toolCallsBeforeText: boolean;
  contentOrder: string[];
  surfaces: unknown[];
} = {
  text: '',
  textSegments: [],
  toolCalls: [],
  toolCallsBeforeText: false,
  contentOrder: [],
  surfaces: [],
};

mock.module('../runtime/gateway-client.js', () => ({
  deliverChannelReply: async (
    callbackUrl: string,
    payload: Record<string, unknown>,
    bearerToken?: string,
  ) => {
    deliveryCalls.push({ callbackUrl, payload, bearerToken });
  },
}));

mock.module('../memory/conversation-store.js', () => ({
  getMessages: () => conversationMessages,
}));

mock.module('../memory/attachments-store.js', () => ({
  getAttachmentMetadataForMessage: (messageId: string) => attachmentsByMessageId.get(messageId) ?? [],
}));

mock.module('../daemon/handlers.js', () => ({
  renderHistoryContent: () => renderedHistoryContent,
}));

const { deliverRenderedReplyViaCallback, deliverReplyViaCallback } = await import('../runtime/channel-reply-delivery.js');

describe('channel-reply-delivery', () => {
  beforeEach(() => {
    deliveryCalls.length = 0;
    conversationMessages.length = 0;
    attachmentsByMessageId.clear();
    renderedHistoryContent = {
      text: '',
      textSegments: [],
      toolCalls: [],
      toolCallsBeforeText: false,
      contentOrder: [],
      surfaces: [],
    };
  });

  it('sends non-empty text segments as separate messages and puts attachments on the last segment', async () => {
    const attachments: RuntimeAttachmentMetadata[] = [
      { id: 'att-1', filename: 'file.txt', mimeType: 'text/plain', sizeBytes: 5, kind: 'uploaded' },
    ];

    await deliverRenderedReplyViaCallback({
      callbackUrl: 'http://gateway/deliver/telegram',
      chatId: 'chat-1',
      textSegments: ['Before tool.', '   ', '', 'After tool.'],
      fallbackText: 'Before tool.After tool.',
      attachments,
      assistantId: 'assistant-1',
      bearerToken: 'token',
      interSegmentDelayMs: 0,
    });

    expect(deliveryCalls).toHaveLength(2);
    expect(deliveryCalls[0]).toEqual({
      callbackUrl: 'http://gateway/deliver/telegram',
      payload: {
        chatId: 'chat-1',
        text: 'Before tool.',
        attachments: undefined,
        assistantId: 'assistant-1',
      },
      bearerToken: 'token',
    });
    expect(deliveryCalls[1]).toEqual({
      callbackUrl: 'http://gateway/deliver/telegram',
      payload: {
        chatId: 'chat-1',
        text: 'After tool.',
        attachments,
        assistantId: 'assistant-1',
      },
      bearerToken: 'token',
    });
  });

  it('falls back to rendered.text when no non-empty textSegments exist', async () => {
    await deliverRenderedReplyViaCallback({
      callbackUrl: 'http://gateway/deliver/sms',
      chatId: 'chat-2',
      textSegments: [' ', ''],
      fallbackText: 'Fallback text',
      interSegmentDelayMs: 0,
    });

    expect(deliveryCalls).toHaveLength(1);
    expect(deliveryCalls[0].payload.text).toBe('Fallback text');
  });

  it('uses rendered textSegments (tool boundaries) when delivering from conversation history', async () => {
    conversationMessages.push(
      { id: 'msg-user', role: 'user', content: 'hi' },
      { id: 'msg-assistant', role: 'assistant', content: '[{"type":"text","text":"ignored"}]' },
    );
    attachmentsByMessageId.set('msg-assistant', [{
      id: 'att-2',
      originalFilename: 'log.txt',
      mimeType: 'text/plain',
      sizeBytes: 42,
      kind: 'uploaded',
    }]);
    renderedHistoryContent = {
      text: 'Before tool.After tool.',
      textSegments: ['Before tool.', 'After tool.'],
      toolCalls: [],
      toolCallsBeforeText: false,
      contentOrder: ['text:0', 'tool:0', 'text:1'],
      surfaces: [],
    };

    await deliverReplyViaCallback(
      'conv-1',
      'chat-3',
      'http://gateway/deliver/telegram',
      'token',
      'assistant-2',
    );

    expect(deliveryCalls).toHaveLength(2);
    expect(deliveryCalls[0].payload).toEqual({
      chatId: 'chat-3',
      text: 'Before tool.',
      attachments: undefined,
      assistantId: 'assistant-2',
    });
    expect(deliveryCalls[1].payload).toEqual({
      chatId: 'chat-3',
      text: 'After tool.',
      attachments: [{
        id: 'att-2',
        filename: 'log.txt',
        mimeType: 'text/plain',
        sizeBytes: 42,
        kind: 'uploaded',
      }],
      assistantId: 'assistant-2',
    });
  });
});
