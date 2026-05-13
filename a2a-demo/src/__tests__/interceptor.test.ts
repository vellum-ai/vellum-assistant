import { describe, test, expect } from 'bun:test';
import type { BeforeArgs, AfterArgs } from '@a2a-js/sdk/client';
import type { AgentCard, Part } from '@a2a-js/sdk';
import { VellumSocialInterceptor } from '../interceptor.js';

const stubAgentCard: AgentCard = {
  name: 'Test Agent',
  url: 'http://localhost:9999/a2a/jsonrpc',
  description: 'Test agent for interceptor tests',
  protocolVersion: '0.2.0',
  version: '0.1.0',
  capabilities: {},
  skills: [],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
};

function makeSendMessageStreamArgs(parts: Part[]): BeforeArgs {
  return {
    input: {
      method: 'sendMessageStream',
      value: {
        message: {
          kind: 'message',
          messageId: 'test-msg-id',
          role: 'user',
          parts,
        },
      },
    },
    agentCard: stubAgentCard,
  } as unknown as BeforeArgs;
}

function makeSendMessageArgs(parts: Part[]): BeforeArgs {
  return {
    input: {
      method: 'sendMessage',
      value: {
        message: {
          kind: 'message',
          messageId: 'test-msg-id',
          role: 'user',
          parts,
        },
      },
    },
    agentCard: stubAgentCard,
  } as unknown as BeforeArgs;
}

describe('VellumSocialInterceptor', () => {
  const extensionData = {
    connection_id: 'conn_demo_peer1',
    sender_relationship: 'colleague' as const,
    correlation_id: 'corr_001',
    deadline: '2026-01-01T12:00:00Z',
  };

  const interceptor = new VellumSocialInterceptor(() => extensionData);

  describe('before — sendMessageStream', () => {
    test('prepends DataPart with extension data to message parts', async () => {
      const originalParts: Part[] = [{ kind: 'text', text: 'coffee?' }];
      const args = makeSendMessageStreamArgs([...originalParts]);

      await interceptor.before(args);

      const parts = (args.input as { value: { message: { parts: Part[] } } }).value.message.parts;
      expect(parts).toHaveLength(2);

      // First part should be the DataPart with extension data
      expect(parts[0].kind).toBe('data');
      expect((parts[0] as { data: Record<string, unknown> }).data).toEqual({
        extension: 'x-vellum-social-v1',
        connection_id: 'conn_demo_peer1',
        sender_relationship: 'colleague',
        correlation_id: 'corr_001',
        deadline: '2026-01-01T12:00:00Z',
      });

      // Second part should be the original TextPart (preserved, not overwritten)
      expect(parts[1].kind).toBe('text');
      expect((parts[1] as { text: string }).text).toBe('coffee?');
    });

    test('DataPart contains all required fields from callback', async () => {
      const customData = {
        connection_id: 'conn_custom',
        sender_relationship: 'friend' as const,
        correlation_id: 'corr_custom',
      };
      const customInterceptor = new VellumSocialInterceptor(() => customData);
      const args = makeSendMessageStreamArgs([{ kind: 'text', text: 'hi' }]);

      await customInterceptor.before(args);

      const parts = (args.input as { value: { message: { parts: Part[] } } }).value.message.parts;
      const dataPart = (parts[0] as { data: Record<string, unknown> }).data;
      expect(dataPart.connection_id).toBe('conn_custom');
      expect(dataPart.sender_relationship).toBe('friend');
      expect(dataPart.correlation_id).toBe('corr_custom');
      expect(dataPart.extension).toBe('x-vellum-social-v1');
    });
  });

  describe('before — sendMessage', () => {
    test('prepends DataPart for non-streaming sendMessage calls', async () => {
      const args = makeSendMessageArgs([{ kind: 'text', text: 'order?' }]);

      await interceptor.before(args);

      const parts = (args.input as { value: { message: { parts: Part[] } } }).value.message.parts;
      expect(parts).toHaveLength(2);
      expect(parts[0].kind).toBe('data');
      expect((parts[0] as { data: Record<string, unknown> }).data).toEqual({
        extension: 'x-vellum-social-v1',
        connection_id: 'conn_demo_peer1',
        sender_relationship: 'colleague',
        correlation_id: 'corr_001',
        deadline: '2026-01-01T12:00:00Z',
      });
    });
  });

  describe('before — method guard', () => {
    test('does not modify args for getTask method', async () => {
      const args = {
        input: {
          method: 'getTask',
          value: { taskId: 'task-123' },
        },
        agentCard: stubAgentCard,
      } as unknown as BeforeArgs;

      const originalValue = JSON.parse(JSON.stringify(args.input));
      await interceptor.before(args);

      // Args should be completely unmodified
      expect(JSON.parse(JSON.stringify(args.input))).toEqual(originalValue);
    });

    test('does not modify args for cancelTask method', async () => {
      const args = {
        input: {
          method: 'cancelTask',
          value: { taskId: 'task-456' },
        },
        agentCard: stubAgentCard,
      } as unknown as BeforeArgs;

      const originalValue = JSON.parse(JSON.stringify(args.input));
      await interceptor.before(args);

      expect(JSON.parse(JSON.stringify(args.input))).toEqual(originalValue);
    });
  });

  describe('after', () => {
    test('does not throw or modify the result', async () => {
      const args = {
        result: {
          method: 'sendMessageStream',
          value: { kind: 'status-update', taskId: 'task-1', contextId: 'ctx-1', status: { state: 'completed' }, final: true },
        },
        agentCard: stubAgentCard,
      } as unknown as AfterArgs;

      const originalResult = JSON.parse(JSON.stringify(args.result));
      await interceptor.after(args);

      expect(JSON.parse(JSON.stringify(args.result))).toEqual(originalResult);
    });
  });
});
