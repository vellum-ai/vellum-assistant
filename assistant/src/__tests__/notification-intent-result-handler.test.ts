import { beforeEach, describe, expect, mock, test } from 'bun:test';

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

let mockDelivery: {
  id: string;
  channel: string;
  conversationId: string | null;
  clientDeliveryStatus: string | null;
} | null = null;
let updateResult = true;

const getDeliveryByIdMock = mock((_id: string) => mockDelivery);
const updateDeliveryClientOutcomeMock = mock(
  (_deliveryId: string, _success: boolean, _error?: { code?: string; message?: string }) => updateResult,
);
const addMessageMock = mock(
  (
    _conversationId: string,
    _role: string,
    _content: string,
    _metadata?: unknown,
    _opts?: unknown,
  ) => ({ id: 'msg-feedback' }),
);

mock.module('../notifications/deliveries-store.js', () => ({
  getDeliveryById: getDeliveryByIdMock,
  updateDeliveryClientOutcome: updateDeliveryClientOutcomeMock,
}));

mock.module('../memory/conversation-store.js', () => ({
  addMessage: addMessageMock,
}));

import { handleNotificationIntentResult } from '../notifications/intent-result-handler.js';

describe('handleNotificationIntentResult', () => {
  beforeEach(() => {
    mockDelivery = {
      id: 'delivery-1',
      channel: 'vellum',
      conversationId: 'conv-1',
      clientDeliveryStatus: null,
    };
    updateResult = true;
    getDeliveryByIdMock.mockClear();
    updateDeliveryClientOutcomeMock.mockClear();
    addMessageMock.mockClear();
  });

  test('persists client outcome for successful post and does not append thread note', () => {
    handleNotificationIntentResult({
      type: 'notification_intent_result',
      deliveryId: 'delivery-1',
      success: true,
    });

    expect(updateDeliveryClientOutcomeMock).toHaveBeenCalledTimes(1);
    expect(updateDeliveryClientOutcomeMock).toHaveBeenCalledWith('delivery-1', true, undefined);
    expect(addMessageMock).not.toHaveBeenCalled();
  });

  test('appends assistant thread note when client reports authorization_denied', () => {
    handleNotificationIntentResult({
      type: 'notification_intent_result',
      deliveryId: 'delivery-1',
      success: false,
      errorCode: 'authorization_denied',
      errorMessage: 'Notification authorization denied',
    });

    expect(updateDeliveryClientOutcomeMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock).toHaveBeenCalledWith(
      'conv-1',
      'assistant',
      expect.stringContaining('notifications are disabled for Vellum'),
      expect.objectContaining({
        assistantMessageChannel: 'vellum',
        notificationDeliveryFeedback: expect.objectContaining({
          deliveryId: 'delivery-1',
          errorCode: 'authorization_denied',
        }),
      }),
      { skipIndexing: true },
    );
  });

  test('does not append note for non-authorization failures', () => {
    handleNotificationIntentResult({
      type: 'notification_intent_result',
      deliveryId: 'delivery-1',
      success: false,
      errorCode: 'post_failed',
      errorMessage: 'UNUserNotificationCenter.add failed',
    });

    expect(updateDeliveryClientOutcomeMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock).not.toHaveBeenCalled();
  });

  test('does not append note when delivery was already acknowledged', () => {
    mockDelivery = {
      id: 'delivery-1',
      channel: 'vellum',
      conversationId: 'conv-1',
      clientDeliveryStatus: 'client_failed',
    };

    handleNotificationIntentResult({
      type: 'notification_intent_result',
      deliveryId: 'delivery-1',
      success: false,
      errorCode: 'authorization_denied',
      errorMessage: 'Notification authorization denied',
    });

    expect(updateDeliveryClientOutcomeMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock).not.toHaveBeenCalled();
  });

  test('does not append note when delivery does not map to vellum conversation', () => {
    mockDelivery = {
      id: 'delivery-1',
      channel: 'telegram',
      conversationId: null,
      clientDeliveryStatus: null,
    };

    handleNotificationIntentResult({
      type: 'notification_intent_result',
      deliveryId: 'delivery-1',
      success: false,
      errorCode: 'authorization_denied',
      errorMessage: 'Notification authorization denied',
    });

    expect(updateDeliveryClientOutcomeMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock).not.toHaveBeenCalled();
  });

  test('returns early when the delivery row cannot be updated', () => {
    updateResult = false;

    handleNotificationIntentResult({
      type: 'notification_intent_result',
      deliveryId: 'missing-delivery',
      success: false,
      errorCode: 'authorization_denied',
      errorMessage: 'Notification authorization denied',
    });

    expect(updateDeliveryClientOutcomeMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock).not.toHaveBeenCalled();
  });

  test('swallows addMessage failures so ack handling never crashes', () => {
    addMessageMock.mockImplementationOnce(() => {
      throw new Error('db locked');
    });

    expect(() =>
      handleNotificationIntentResult({
        type: 'notification_intent_result',
        deliveryId: 'delivery-1',
        success: false,
        errorCode: 'authorization_denied',
        errorMessage: 'Notification authorization denied',
      }),
    ).not.toThrow();
  });
});
