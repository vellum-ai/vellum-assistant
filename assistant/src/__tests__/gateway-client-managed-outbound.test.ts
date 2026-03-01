import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { deliverChannelReply } from '../runtime/gateway-client.js';

type FetchCall = {
  url: string;
  init: RequestInit;
};

describe('gateway-client managed outbound lane', () => {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];

  beforeEach(() => {
    calls.length = 0;
    globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify({ status: 'accepted' }), { status: 202 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('translates managed callback URL into managed outbound-send request', async () => {
    await deliverChannelReply(
      'https://platform.test/v1/internal/managed-gateway/outbound-send/?route_id=route-123&assistant_id=assistant-123&source_channel=sms&source_update_id=SM-inbound-123&callback_token=runtime-token',
      {
        chatId: '+15550001111',
        text: 'hello from runtime',
      },
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe('https://platform.test/v1/internal/managed-gateway/outbound-send/');

    const headers = call.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Managed-Gateway-Callback-Token']).toBe('runtime-token');
    expect(headers.Authorization).toBeUndefined();

    const body = JSON.parse(String(call.init.body)) as {
      route_id: string;
      assistant_id: string;
      normalized_send: {
        sourceChannel: string;
        message: {
          to: string;
          content: string;
          externalMessageId: string;
        };
        source: {
          requestId: string;
        };
        raw: {
          sourceUpdateId: string;
        };
      };
    };
    expect(body.route_id).toBe('route-123');
    expect(body.assistant_id).toBe('assistant-123');
    expect(body.normalized_send.sourceChannel).toBe('sms');
    expect(body.normalized_send.message.to).toBe('+15550001111');
    expect(body.normalized_send.message.content).toBe('hello from runtime');
    expect(body.normalized_send.message.externalMessageId).toStartWith('mgw-send-');
    expect(body.normalized_send.source.requestId).toBe(
      body.normalized_send.message.externalMessageId,
    );
    expect(body.normalized_send.raw.sourceUpdateId).toBe('SM-inbound-123');
  });

  test('falls back to standard callback delivery for non-managed callback URL', async () => {
    await deliverChannelReply(
      'https://gateway.test/deliver/sms',
      {
        chatId: '+15550001111',
        text: 'standard gateway callback',
      },
      'runtime-bearer',
    );

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe('https://gateway.test/deliver/sms');

    const headers = call.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers.Authorization).toBe('Bearer runtime-bearer');

    const body = JSON.parse(String(call.init.body)) as { chatId: string; text: string };
    expect(body).toEqual({
      chatId: '+15550001111',
      text: 'standard gateway callback',
    });
  });
});
