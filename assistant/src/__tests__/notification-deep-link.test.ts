/**
 * Regression tests for Vellum notification deep-link metadata.
 *
 * Validates that the VellumAdapter broadcasts notification_intent with
 * deepLinkMetadata, and that the broadcaster correctly passes deepLinkTarget
 * from the decision through to the adapter payload.
 */

import { describe, expect, mock, test } from 'bun:test';

// -- Mocks (must be declared before importing modules that depend on them) ----

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import type { ServerMessage } from '../daemon/ipc-contract.js';
import { VellumAdapter } from '../notifications/adapters/macos.js';

// -- Tests -------------------------------------------------------------------

describe('notification deep-link metadata', () => {
  describe('VellumAdapter', () => {
    test('broadcasts notification_intent with deepLinkMetadata from payload', async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      await adapter.send(
        {
          sourceEventName: 'test.event',
          copy: { title: 'Alert', body: 'Something happened' },
          deepLinkTarget: { conversationId: 'conv-123', threadType: 'notification' },
        },
        { channel: 'vellum' },
      );

      expect(messages).toHaveLength(1);
      const msg = messages[0] as unknown as Record<string, unknown>;
      expect(msg.type).toBe('notification_intent');
      expect(msg.title).toBe('Alert');
      expect(msg.body).toBe('Something happened');
      expect(msg.deepLinkMetadata).toEqual({
        conversationId: 'conv-123',
        threadType: 'notification',
      });
    });

    test('broadcasts notification_intent without deepLinkMetadata when absent', async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      await adapter.send(
        {
          sourceEventName: 'test.event',
          copy: { title: 'Alert', body: 'No deep link' },
        },
        { channel: 'vellum' },
      );

      expect(messages).toHaveLength(1);
      const msg = messages[0] as unknown as Record<string, unknown>;
      expect(msg.type).toBe('notification_intent');
      expect(msg.deepLinkMetadata).toBeUndefined();
    });

    test('includes conversationId in deepLinkMetadata for navigation', async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      const conversationId = 'conv-deep-link-test';
      await adapter.send(
        {
          sourceEventName: 'guardian.question',
          copy: { title: 'Guardian Question', body: 'What is the code?' },
          deepLinkTarget: { conversationId },
        },
        { channel: 'vellum' },
      );

      const msg = messages[0] as unknown as Record<string, unknown>;
      const metadata = msg.deepLinkMetadata as Record<string, unknown>;
      expect(metadata.conversationId).toBe(conversationId);
    });

    test('returns success: true on successful broadcast', async () => {
      const adapter = new VellumAdapter(() => {});

      const result = await adapter.send(
        {
          sourceEventName: 'test.event',
          copy: { title: 'T', body: 'B' },
        },
        { channel: 'vellum' },
      );

      expect(result.success).toBe(true);
    });

    test('returns success: false when broadcast throws', async () => {
      const adapter = new VellumAdapter(() => {
        throw new Error('IPC connection lost');
      });

      const result = await adapter.send(
        {
          sourceEventName: 'test.event',
          copy: { title: 'T', body: 'B' },
        },
        { channel: 'vellum' },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('IPC connection lost');
    });

    test('sourceEventName is included in the IPC payload', async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      await adapter.send(
        {
          sourceEventName: 'guardian.question',
          copy: { title: 'Alert', body: 'Body' },
        },
        { channel: 'vellum' },
      );

      const msg = messages[0] as unknown as Record<string, unknown>;
      expect(msg.sourceEventName).toBe('guardian.question');
    });

    test('deepLinkMetadata with conversationId enables client-side navigation', async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      // Simulate a notification that should deep-link to a specific conversation
      await adapter.send(
        {
          sourceEventName: 'activity.complete',
          copy: { title: 'Task Done', body: 'Your task has completed' },
          deepLinkTarget: {
            conversationId: 'conv-task-run-42',
            workItemId: 'work-item-7',
          },
        },
        { channel: 'vellum' },
      );

      const msg = messages[0] as unknown as Record<string, unknown>;
      const metadata = msg.deepLinkMetadata as Record<string, unknown>;
      expect(metadata.conversationId).toBe('conv-task-run-42');
      expect(metadata.workItemId).toBe('work-item-7');
    });
  });
});
