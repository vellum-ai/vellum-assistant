import { describe, expect, mock, test } from 'bun:test';
import type { RuntimeMessageSessionOptions } from '../runtime/http-types.js';

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../memory/conversation-key-store.js', () => ({
  getOrCreateConversation: () => ({ conversationId: 'conv-legacy-test' }),
  getConversationByKey: () => null,
}));

mock.module('../memory/attachments-store.js', () => ({
  getAttachmentsByIds: () => [],
}));

import { handleSendMessage } from '../runtime/routes/conversation-routes.js';

describe('handleSendMessage', () => {
  test('legacy fallback passes guardian context to processor', async () => {
    let capturedOptions: RuntimeMessageSessionOptions | undefined;
    let capturedSourceChannel: string | undefined;

    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationKey: 'legacy-fallback-key',
        content: 'Hello from legacy fallback',
        sourceChannel: 'telegram',
      }),
    });

    const res = await handleSendMessage(req, {
      processMessage: async (_conversationId, _content, _attachmentIds, options, sourceChannel) => {
        capturedOptions = options;
        capturedSourceChannel = sourceChannel;
        return { messageId: 'msg-legacy-fallback' };
      },
    });

    const body = await res.json() as { accepted: boolean; messageId: string };
    expect(res.status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(body.messageId).toBe('msg-legacy-fallback');
    expect(capturedSourceChannel).toBe('telegram');
    expect(capturedOptions?.guardianContext).toEqual({
      actorRole: 'guardian',
      sourceChannel: 'telegram',
    });
  });
});
