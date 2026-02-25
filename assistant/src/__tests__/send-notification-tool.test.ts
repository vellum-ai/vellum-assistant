import { beforeEach, describe, expect, mock, test } from 'bun:test';

const emitNotificationSignalMock = mock(async (_params: unknown) => {});
const getConfigMock = mock(() => ({
  notifications: {
    enabled: true,
    shadowMode: false,
  },
}));

mock.module('../config/loader.js', () => ({
  getConfig: () => getConfigMock() as any,
}));

mock.module('../notifications/emit-signal.js', () => ({
  emitNotificationSignal: (params: unknown) => emitNotificationSignalMock(params),
}));

import { run } from '../config/bundled-skills/messaging/tools/send-notification.js';

describe('send-notification tool', () => {
  beforeEach(() => {
    emitNotificationSignalMock.mockClear();
    getConfigMock.mockClear();
    getConfigMock.mockReturnValue({
      notifications: {
        enabled: true,
        shadowMode: false,
      },
    });
  });

  test('emits a notification signal with normalized routing context', async () => {
    const result = await run(
      {
        message: 'Your verification code is 123456',
        title: 'Verification code',
        urgency: 'high',
        requires_action: true,
        preferred_channels: ['vellum'],
        deep_link_metadata: { conversationId: 'conv-deeplink' },
        dedupe_key: 'voice-code-123456',
      },
      {
        workingDir: '/tmp',
        sessionId: 'sess-1',
        conversationId: 'conv-1',
        assistantId: 'ast-alpha',
      },
    );

    expect(result.isError).toBe(false);
    expect(emitNotificationSignalMock).toHaveBeenCalledTimes(1);
    expect(emitNotificationSignalMock).toHaveBeenCalledWith({
      sourceEventName: 'user.send_notification',
      sourceChannel: 'assistant_tool',
      sourceSessionId: 'conv-1',
      assistantId: 'ast-alpha',
      attentionHints: {
        requiresAction: true,
        urgency: 'high',
        deadlineAt: undefined,
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: {
        requestedMessage: 'Your verification code is 123456',
        requestedByTool: 'send_notification',
        requestedBySessionId: 'sess-1',
        requestedTitle: 'Verification code',
        requestedByConversationId: 'conv-1',
        preferredChannels: ['vellum'],
        deepLinkMetadata: { conversationId: 'conv-deeplink' },
      },
      dedupeKey: 'voice-code-123456',
    });
  });

  test('returns an error when notifications are disabled', async () => {
    getConfigMock.mockReturnValue({
      notifications: {
        enabled: false,
        shadowMode: false,
      },
    });

    const result = await run(
      { message: 'test notification' },
      {
        workingDir: '/tmp',
        sessionId: 'sess-1',
        conversationId: 'conv-1',
        assistantId: 'ast-alpha',
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('disabled');
    expect(emitNotificationSignalMock).not.toHaveBeenCalled();
  });

  test('returns an error when notifications are in shadow mode', async () => {
    getConfigMock.mockReturnValue({
      notifications: {
        enabled: true,
        shadowMode: true,
      },
    });

    const result = await run(
      { message: 'test notification' },
      {
        workingDir: '/tmp',
        sessionId: 'sess-1',
        conversationId: 'conv-1',
        assistantId: 'ast-alpha',
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('shadow mode');
    expect(emitNotificationSignalMock).not.toHaveBeenCalled();
  });
});
