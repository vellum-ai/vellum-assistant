import { describe, expect, mock, test } from 'bun:test';

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

mock.module('../runtime/local-actor-identity.js', () => ({
  resolveLocalIpcGuardianContext: (sourceChannel: string) => ({ trustClass: 'guardian', sourceChannel }),
}));

import type { ServerWithRequestIP } from '../runtime/middleware/actor-token.js';
import { handleSendMessage } from '../runtime/routes/conversation-routes.js';

const mockLoopbackServer: ServerWithRequestIP = {
  requestIP: () => ({ address: '127.0.0.1', family: 'IPv4', port: 0 }),
};

describe('handleSendMessage', () => {
  test('returns 503 when sendMessageDeps is not configured', async () => {
    const req = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationKey: 'no-deps-key',
        content: 'Hello without deps',
        sourceChannel: 'telegram',
        interface: 'telegram',
      }),
    });

    const res = await handleSendMessage(req, {}, mockLoopbackServer);

    expect(res.status).toBe(503);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.error.message).toBe('Message processing not configured');
  });
});
