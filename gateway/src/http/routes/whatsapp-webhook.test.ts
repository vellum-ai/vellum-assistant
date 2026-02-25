import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { GatewayConfig } from '../../config.js';

const handleInboundMock = mock(() => Promise.resolve({ forwarded: true, rejected: false }));
const resetConversationMock = mock(() => Promise.resolve());
const sendWhatsAppReplyMock = mock(() => Promise.resolve());
const markWhatsAppMessageReadMock = mock(() => Promise.resolve());
const normalizeWhatsAppWebhookMock = mock(() => [] as Array<{ event: Record<string, unknown>; whatsappMessageId: string }>);
const verifyWhatsAppWebhookSignatureMock = mock(() => true);

mock.module('../../handlers/handle-inbound.js', () => ({
  handleInbound: handleInboundMock,
}));

mock.module('../../runtime/client.js', () => ({
  resetConversation: resetConversationMock,
  CircuitBreakerOpenError: class extends Error {},
}));

mock.module('../../whatsapp/send.js', () => ({
  sendWhatsAppReply: sendWhatsAppReplyMock,
  sendWhatsAppAttachments: mock(() => Promise.resolve({ allFailed: false, failureCount: 0, totalCount: 0 })),
}));

mock.module('../../whatsapp/api.js', () => ({
  markWhatsAppMessageRead: markWhatsAppMessageReadMock,
}));

mock.module('../../whatsapp/normalize.js', () => ({
  normalizeWhatsAppWebhook: normalizeWhatsAppWebhookMock,
}));

mock.module('../../whatsapp/verify.js', () => ({
  verifyWhatsAppWebhookSignature: verifyWhatsAppWebhookSignatureMock,
}));

const { createWhatsAppWebhookHandler } = await import('./whatsapp-webhook.js');

const baseConfig: GatewayConfig = {
  assistantRuntimeBaseUrl: 'http://localhost:7821',
  defaultAssistantId: 'ast-default',
  gatewayInternalBaseUrl: 'http://127.0.0.1:7830',
  logFile: { dir: undefined, retentionDays: 30 },
  maxAttachmentBytes: 20 * 1024 * 1024,
  maxAttachmentConcurrency: 3,
  maxWebhookPayloadBytes: 1024 * 1024,
  port: 7830,
  routingEntries: [],
  runtimeBearerToken: undefined,
  runtimeGatewayOriginSecret: undefined,
  runtimeInitialBackoffMs: 500,
  runtimeMaxRetries: 2,
  runtimeProxyBearerToken: undefined,
  runtimeProxyEnabled: false,
  runtimeProxyRequireAuth: true,
  runtimeTimeoutMs: 30000,
  shutdownDrainMs: 5000,
  telegramApiBaseUrl: 'https://api.telegram.org',
  telegramBotToken: undefined,
  telegramDeliverAuthBypass: false,
  telegramInitialBackoffMs: 1000,
  telegramMaxRetries: 3,
  telegramTimeoutMs: 15000,
  telegramWebhookSecret: undefined,
  twilioAuthToken: undefined,
  twilioAccountSid: undefined,
  twilioPhoneNumber: undefined,
  smsDeliverAuthBypass: false,
  ingressPublicBaseUrl: undefined,
  unmappedPolicy: 'default',
  whatsappPhoneNumberId: 'phone-id',
  whatsappAccessToken: 'access-token',
  whatsappAppSecret: 'whatsapp-secret',
  whatsappWebhookVerifyToken: 'verify-token',
  whatsappDeliverAuthBypass: false,
  whatsappTimeoutMs: 15000,
  whatsappMaxRetries: 3,
  whatsappInitialBackoffMs: 1000,
    trustProxy: false,
};

function buildPostReq(body: Record<string, unknown>): Request {
  return new Request('http://localhost:7830/webhooks/whatsapp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

describe('whatsapp-webhook', () => {
  beforeEach(() => {
    handleInboundMock.mockClear();
    handleInboundMock.mockImplementation(() => Promise.resolve({ forwarded: true, rejected: false }));
    resetConversationMock.mockClear();
    sendWhatsAppReplyMock.mockClear();
    markWhatsAppMessageReadMock.mockClear();
    normalizeWhatsAppWebhookMock.mockClear();
    normalizeWhatsAppWebhookMock.mockImplementation(() => []);
    verifyWhatsAppWebhookSignatureMock.mockClear();
    verifyWhatsAppWebhookSignatureMock.mockImplementation(() => true);
  });

  it('validates GET verify-token handshake', async () => {
    const handler = createWhatsAppWebhookHandler(baseConfig);
    const req = new Request(
      'http://localhost:7830/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-token&hub.challenge=12345',
      { method: 'GET' },
    );

    const res = await handler(req);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('12345');
  });

  it('rejects GET verify-token handshake when token mismatches', async () => {
    const handler = createWhatsAppWebhookHandler(baseConfig);
    const req = new Request(
      'http://localhost:7830/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345',
      { method: 'GET' },
    );

    const res = await handler(req);
    expect(res.status).toBe(403);
  });

  it('fails closed when whatsappAppSecret is not configured', async () => {
    const handler = createWhatsAppWebhookHandler({
      ...baseConfig,
      whatsappAppSecret: undefined,
    });

    const res = await handler(buildPostReq({ object: 'whatsapp_business_account', entry: [] }));
    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Webhook signature validation not configured');
  });

  it('rejects POST when signature verification fails', async () => {
    verifyWhatsAppWebhookSignatureMock.mockImplementation(() => false);

    const handler = createWhatsAppWebhookHandler(baseConfig);
    const res = await handler(buildPostReq({ object: 'whatsapp_business_account', entry: [] }));

    expect(res.status).toBe(403);
    expect(verifyWhatsAppWebhookSignatureMock).toHaveBeenCalledTimes(1);
  });

  it('acknowledges non-message payloads without forwarding', async () => {
    const handler = createWhatsAppWebhookHandler(baseConfig);
    normalizeWhatsAppWebhookMock.mockImplementation(() => []);

    const res = await handler(buildPostReq({ object: 'whatsapp_business_account', entry: [] }));

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(handleInboundMock).not.toHaveBeenCalled();
  });

  it('forwards normalized inbound WhatsApp messages to runtime with channel metadata', async () => {
    const handler = createWhatsAppWebhookHandler(baseConfig);

    normalizeWhatsAppWebhookMock.mockImplementation(() => [{
      whatsappMessageId: 'wamid-1',
      event: {
        version: 'v1',
        sourceChannel: 'whatsapp',
        receivedAt: new Date().toISOString(),
        message: {
          content: 'hello from whatsapp',
          externalChatId: '15551230000',
          externalMessageId: 'wamid-1',
        },
        sender: {
          externalUserId: '15551230000',
          displayName: 'Alice',
        },
        source: {
          updateId: 'wamid-1',
          messageId: 'wamid-1',
          chatType: 'private',
        },
        raw: {},
      },
    }]);

    const res = await handler(buildPostReq({ object: 'whatsapp_business_account', entry: [] }));

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);

    expect(handleInboundMock).toHaveBeenCalledTimes(1);
    const [_cfg, event, options] = handleInboundMock.mock.calls[0] as unknown as [
      GatewayConfig,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(event.sourceChannel).toBe('whatsapp');
    expect(options.replyCallbackUrl).toBe('http://127.0.0.1:7830/deliver/whatsapp');
    expect((options.transportMetadata as { hints: string[] }).hints).toContain('whatsapp-formatting');
    expect(markWhatsAppMessageReadMock).toHaveBeenCalledWith(baseConfig, 'wamid-1');
  });

  it('returns 500 when runtime forwarding fails for a normalized message', async () => {
    const handler = createWhatsAppWebhookHandler(baseConfig);
    normalizeWhatsAppWebhookMock.mockImplementation(() => [{
      whatsappMessageId: 'wamid-fail',
      event: {
        version: 'v1',
        sourceChannel: 'whatsapp',
        receivedAt: new Date().toISOString(),
        message: {
          content: 'hello',
          externalChatId: '15550000001',
          externalMessageId: 'wamid-fail',
        },
        sender: {
          externalUserId: '15550000001',
          displayName: 'Bob',
        },
        source: {
          updateId: 'wamid-fail',
          messageId: 'wamid-fail',
          chatType: 'private',
        },
        raw: {},
      },
    }]);
    handleInboundMock.mockImplementation(() => Promise.resolve({ forwarded: false, rejected: false }));

    const res = await handler(buildPostReq({ object: 'whatsapp_business_account', entry: [] }));

    expect(res.status).toBe(500);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Internal error');
  });
});
