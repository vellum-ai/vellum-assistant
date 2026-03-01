import * as net from 'node:net';

import { describe, expect, test } from 'bun:test';

const { handleUserMessage } = await import('../daemon/handlers/sessions.js');

describe('handleUserMessage secret redirect continuation', () => {
  test('resumes the request after secure save with redacted continuation text', async () => {
    const sentMessages: Array<Record<string, unknown>> = [];
    const enqueueCalls: Array<Record<string, unknown>> = [];
    const processCalls: Array<Record<string, unknown>> = [];

    const session = {
      hasEscalationHandler: () => true,
      redirectToSecurePrompt: (
        _detectedTypes: string[],
        options?: { onStored?: (record: { service: string; field: string; label: string; delivery: 'store' | 'transient_send' }) => void },
      ) => {
        options?.onStored?.({
          service: 'telegram',
          field: 'bot_token',
          label: 'Telegram Bot Token',
          delivery: 'store',
        });
      },
      traceEmitter: { emit: () => {} },
      enqueueMessage: (
        content: string,
        _attachments: unknown[],
        _onEvent: unknown,
        requestId: string,
      ) => {
        enqueueCalls.push({ content, requestId });
        return { queued: false, requestId };
      },
      getQueueDepth: () => 0,
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setAssistantId: () => {},
      setChannelCapabilities: () => {},
      setGuardianContext: () => {},
      setCommandIntent: () => {},
      updateClient: () => {},
      processMessage: (content: string, _attachments: unknown[], _onEvent: unknown, requestId: string) => {
        processCalls.push({ content, requestId });
        return Promise.resolve();
      },
    };

    const ctx = {
      socketToSession: new Map<net.Socket, string>(),
      sessions: new Map(),
      cuSessions: new Map(),
      getOrCreateSession: async () => session,
      send: (_socket: net.Socket, message: Record<string, unknown>) => {
        sentMessages.push(message);
      },
    };

    await handleUserMessage(
      {
        type: 'user_message',
        sessionId: 'sess-1',
        content: 'Set up Telegram with my bot token 123456789:ABCDefGHIJklmnopQRSTuvwxyz012345678',
        interface: 'cli',
      },
      new net.Socket(),
      ctx as never,
    );

    expect(sentMessages[0]).toMatchObject({
      type: 'error',
      category: 'secret_blocked',
    });
    expect(sentMessages.some((msg) => msg.type === 'assistant_text_delta')).toBe(true);
    expect(sentMessages.some((msg) => msg.type === 'message_complete')).toBe(true);

    expect(enqueueCalls).toHaveLength(1);
    expect(processCalls).toHaveLength(1);
    expect(enqueueCalls[0].content as string).toContain('<redacted type="Telegram Bot Token" />');
    expect(enqueueCalls[0].content as string).toContain('credential telegram/bot_token');
    expect(processCalls[0].content).toBe(enqueueCalls[0].content);
  });
});
