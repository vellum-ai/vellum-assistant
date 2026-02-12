import { describe, test, expect } from 'bun:test';
import { ComputerUseSession } from '../daemon/computer-use-session.js';
import type { Provider, ProviderResponse } from '../providers/types.js';
import type { CuObservation, ServerMessage } from '../daemon/ipc-protocol.js';
import { registerComputerUseTools } from '../tools/computer-use/registry.js';

registerComputerUseTools();

function createProvider(responses: ProviderResponse[]): { provider: Provider; getCalls: () => number } {
  let calls = 0;
  const provider: Provider = {
    name: 'mock',
    async sendMessage() {
      const response = responses[calls] ?? responses[responses.length - 1];
      calls++;
      return response;
    },
  };
  return { provider, getCalls: () => calls };
}

describe('ComputerUseSession lifecycle', () => {
  test('stops provider loop immediately after terminal cu_done tool', async () => {
    const { provider, getCalls } = createProvider([
      {
        content: [{
          type: 'tool_use',
          id: 'tu-1',
          name: 'cu_done',
          input: { summary: 'Task finished' },
        }],
        model: 'mock-model',
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'tool_use',
      },
      {
        content: [{ type: 'text', text: 'This should never be requested' }],
        model: 'mock-model',
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'end_turn',
      },
    ]);

    const sentMessages: ServerMessage[] = [];
    let terminalCalls = 0;

    const session = new ComputerUseSession(
      'cu-test-1',
      'test task',
      1440,
      900,
      provider,
      (msg) => { sentMessages.push(msg); },
      'computer_use',
      () => { terminalCalls++; },
    );

    const observation: CuObservation = {
      type: 'cu_observation',
      sessionId: 'cu-test-1',
      axTree: 'Window "Test" [1]',
    };

    await session.handleObservation(observation);

    // If cu_done does not abort the loop, we'd see an extra provider call.
    expect(getCalls()).toBe(1);
    expect(session.getState()).toBe('complete');
    expect(terminalCalls).toBe(1);

    const completes = sentMessages.filter(
      (msg): msg is Extract<ServerMessage, { type: 'cu_complete' }> => msg.type === 'cu_complete',
    );
    expect(completes).toHaveLength(1);
    expect(completes[0].summary).toBe('Task finished');
  });

  test('notifies terminal callback only once on repeated abort calls', () => {
    const { provider } = createProvider([
      {
        content: [{ type: 'text', text: 'unused' }],
        model: 'mock-model',
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: 'end_turn',
      },
    ]);

    let terminalCalls = 0;
    const session = new ComputerUseSession(
      'cu-test-2',
      'test task',
      1440,
      900,
      provider,
      () => {},
      'computer_use',
      () => { terminalCalls++; },
    );

    session.abort();
    session.abort();

    expect(terminalCalls).toBe(1);
    expect(session.getState()).toBe('error');
  });
});
