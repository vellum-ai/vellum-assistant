import { describe, test, expect } from 'bun:test';
import { serialize } from '../daemon/ipc-protocol.js';
import type {
  ClientMessage,
  ServerMessage,
} from '../daemon/ipc-protocol.js';

/**
 * Snapshot tests for every IPC message type.
 * If any field is added, removed, or renamed, these tests will fail,
 * catching accidental protocol changes.
 */

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

const clientMessages: Record<string, ClientMessage> = {
  user_message: {
    type: 'user_message',
    sessionId: 'sess-001',
    content: 'Hello, assistant!',
  },
  confirmation_response: {
    type: 'confirmation_response',
    requestId: 'req-001',
    decision: 'allow',
    selectedPattern: 'bash:npm *',
    selectedScope: '/projects/my-app',
  },
  session_list: {
    type: 'session_list',
  },
  session_create: {
    type: 'session_create',
    title: 'New session',
  },
  session_switch: {
    type: 'session_switch',
    sessionId: 'sess-002',
  },
  ping: {
    type: 'ping',
  },
  cancel: {
    type: 'cancel',
  },
  model_get: {
    type: 'model_get',
  },
  model_set: {
    type: 'model_set',
    model: 'claude-sonnet-4-5-20250929',
  },
  history_request: {
    type: 'history_request',
    sessionId: 'sess-001',
  },
  undo: {
    type: 'undo',
    sessionId: 'sess-001',
  },
  usage_request: {
    type: 'usage_request',
    sessionId: 'sess-001',
  },
  sandbox_set: {
    type: 'sandbox_set',
    enabled: true,
  },
};

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

const serverMessages: Record<string, ServerMessage> = {
  assistant_text_delta: {
    type: 'assistant_text_delta',
    text: 'Here is some output',
  },
  assistant_thinking_delta: {
    type: 'assistant_thinking_delta',
    thinking: 'Let me consider this...',
  },
  tool_use_start: {
    type: 'tool_use_start',
    toolName: 'bash',
    input: { command: 'ls -la' },
  },
  tool_output_chunk: {
    type: 'tool_output_chunk',
    chunk: 'file1.ts\nfile2.ts\n',
  },
  tool_result: {
    type: 'tool_result',
    toolName: 'bash',
    result: 'Command completed successfully',
    isError: false,
    diff: {
      filePath: '/tmp/test.ts',
      oldContent: 'const x = 1;',
      newContent: 'const x = 2;',
      isNewFile: false,
    },
    status: 'success',
  },
  confirmation_request: {
    type: 'confirmation_request',
    requestId: 'req-002',
    toolName: 'bash',
    input: { command: 'rm -rf /tmp/test' },
    riskLevel: 'high',
    allowlistOptions: [
      { label: 'Allow rm commands', pattern: 'bash:rm *' },
    ],
    scopeOptions: [
      { label: 'In /tmp', scope: '/tmp' },
    ],
    diff: {
      filePath: '/tmp/test.ts',
      oldContent: 'old',
      newContent: 'new',
      isNewFile: false,
    },
    sandboxed: false,
  },
  message_complete: {
    type: 'message_complete',
  },
  session_info: {
    type: 'session_info',
    sessionId: 'sess-001',
    title: 'My session',
  },
  session_list_response: {
    type: 'session_list_response',
    sessions: [
      { id: 'sess-001', title: 'First session', updatedAt: 1700000000 },
      { id: 'sess-002', title: 'Second session', updatedAt: 1700001000 },
    ],
  },
  error: {
    type: 'error',
    message: 'Something went wrong',
  },
  pong: {
    type: 'pong',
  },
  generation_cancelled: {
    type: 'generation_cancelled',
  },
  model_info: {
    type: 'model_info',
    model: 'claude-sonnet-4-5-20250929',
    provider: 'anthropic',
  },
  history_response: {
    type: 'history_response',
    messages: [
      { role: 'user', text: 'Hello', timestamp: 1700000000 },
      { role: 'assistant', text: 'Hi there!', timestamp: 1700000001 },
    ],
  },
  undo_complete: {
    type: 'undo_complete',
    removedCount: 2,
  },
  usage_update: {
    type: 'usage_update',
    inputTokens: 150,
    outputTokens: 50,
    totalInputTokens: 1500,
    totalOutputTokens: 500,
    estimatedCost: 0.025,
    model: 'claude-sonnet-4-5-20250929',
  },
  usage_response: {
    type: 'usage_response',
    totalInputTokens: 1500,
    totalOutputTokens: 500,
    estimatedCost: 0.025,
    model: 'claude-sonnet-4-5-20250929',
  },
  secret_detected: {
    type: 'secret_detected',
    toolName: 'bash',
    matches: [
      { type: 'api_key', redactedValue: 'sk-****abcd' },
    ],
    action: 'redact',
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IPC message snapshots', () => {
  describe('ClientMessage types', () => {
    for (const [name, msg] of Object.entries(clientMessages)) {
      test(`${name} serializes to expected JSON`, () => {
        const serialized = serialize(msg);
        // serialize appends a newline; strip it for the snapshot comparison
        const json = JSON.parse(serialized);
        expect(json).toMatchSnapshot();
      });
    }
  });

  describe('ServerMessage types', () => {
    for (const [name, msg] of Object.entries(serverMessages)) {
      test(`${name} serializes to expected JSON`, () => {
        const serialized = serialize(msg);
        const json = JSON.parse(serialized);
        expect(json).toMatchSnapshot();
      });
    }
  });

  test('round-trip: serialize then parse matches original for all ClientMessages', () => {
    for (const msg of Object.values(clientMessages)) {
      const serialized = serialize(msg);
      const parsed = JSON.parse(serialized.trimEnd());
      expect(parsed).toEqual(msg);
    }
  });

  test('round-trip: serialize then parse matches original for all ServerMessages', () => {
    for (const msg of Object.values(serverMessages)) {
      const serialized = serialize(msg);
      const parsed = JSON.parse(serialized.trimEnd());
      expect(parsed).toEqual(msg);
    }
  });
});
