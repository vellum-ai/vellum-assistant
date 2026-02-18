import { describe, expect, test } from 'bun:test';
import { SubagentManager } from '../subagent/manager.js';
import type { SubagentState } from '../subagent/types.js';
import type { ServerMessage } from '../daemon/ipc-contract.js';

/**
 * Inject a fake managed subagent into the manager's private maps
 * so we can test abort/notification logic without needing a real Session.
 */
function injectFakeSubagent(
  manager: SubagentManager,
  subagentId: string,
  state: SubagentState,
): void {
  const fakeSession = {
    abort: () => {},
    dispose: () => {},
    messages: [],
    sendToClient: () => {},
  };

  // Access private maps via bracket notation.
  const subagents = (manager as any).subagents as Map<string, any>;
  const parentToChildren = (manager as any).parentToChildren as Map<string, Set<string>>;

  subagents.set(subagentId, { session: fakeSession, state });

  const parentId = state.config.parentSessionId;
  if (!parentToChildren.has(parentId)) {
    parentToChildren.set(parentId, new Set());
  }
  parentToChildren.get(parentId)!.add(subagentId);
}

function makeState(
  subagentId: string,
  overrides: Partial<SubagentState> = {},
): SubagentState {
  return {
    config: {
      id: subagentId,
      parentSessionId: 'parent-sess-1',
      label: 'Test subagent',
      objective: 'Do something',
    },
    status: 'running',
    conversationId: 'conv-sub-1',
    createdAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    ...overrides,
  };
}

describe('SubagentManager abort notification', () => {
  test('abort notifies parent with abort message', () => {
    const manager = new SubagentManager();
    const subagentId = 'sub-1';
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    const notifications: { parentSessionId: string; message: string }[] = [];
    manager.onSubagentFinished = (parentSessionId, message) => {
      notifications.push({ parentSessionId, message });
    };

    const clientMessages: ServerMessage[] = [];
    const sendToClient = (msg: ServerMessage) => clientMessages.push(msg);

    const result = manager.abort(subagentId, sendToClient);

    expect(result).toBe(true);
    expect(state.status).toBe('aborted');
    expect(notifications).toHaveLength(1);
    expect(notifications[0].parentSessionId).toBe('parent-sess-1');
    expect(notifications[0].message).toContain('[Subagent "Test subagent" was aborted]');
  });

  test('abort sends subagent_status_changed to client', () => {
    const manager = new SubagentManager();
    const subagentId = 'sub-1';
    injectFakeSubagent(manager, subagentId, makeState(subagentId));

    const clientMessages: any[] = [];
    const sendToClient = (msg: ServerMessage) => clientMessages.push(msg);

    manager.abort(subagentId, sendToClient);

    const statusMsg = clientMessages.find((m) => m.type === 'subagent_status_changed');
    expect(statusMsg).toBeDefined();
    expect(statusMsg.subagentId).toBe(subagentId);
    expect(statusMsg.status).toBe('aborted');
  });

  test('abort returns false for unknown subagent', () => {
    const manager = new SubagentManager();
    const result = manager.abort('nonexistent');
    expect(result).toBe(false);
  });

  test('abort returns false for already-terminal subagent', () => {
    const manager = new SubagentManager();
    const subagentId = 'sub-1';
    injectFakeSubagent(manager, subagentId, makeState(subagentId, { status: 'completed' }));

    const result = manager.abort(subagentId, () => {});
    expect(result).toBe(false);
  });

  test('abort without sendToClient sets status but does not notify', () => {
    const manager = new SubagentManager();
    const subagentId = 'sub-1';
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    let notified = false;
    manager.onSubagentFinished = () => { notified = true; };

    const result = manager.abort(subagentId);

    expect(result).toBe(true);
    expect(state.status).toBe('aborted');
    expect(notified).toBe(false);
  });
});

describe('SubagentManager notifyParent (via runSubagent)', () => {
  test('completed subagent notifies parent with summary', async () => {
    const manager = new SubagentManager();
    const subagentId = 'sub-1';
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    // Patch the fake session to simulate a successful agent loop.
    const managed = (manager as any).subagents.get(subagentId);
    managed.session.loadFromDb = async () => {};
    managed.session.persistUserMessage = () => 'msg-1';
    managed.session.runAgentLoop = async () => {};
    managed.session.messages = [
      { role: 'assistant', content: [{ type: 'text', text: 'Task completed successfully.' }] },
    ];

    const notifications: { parentSessionId: string; message: string }[] = [];
    manager.onSubagentFinished = (parentSessionId, message) => {
      notifications.push({ parentSessionId, message });
    };

    const clientMessages: any[] = [];
    const sendToClient = (msg: ServerMessage) => clientMessages.push(msg);

    // Call private runSubagent directly.
    await (manager as any).runSubagent(subagentId, 'Do something', sendToClient);

    expect(state.status).toBe('completed');
    expect(notifications).toHaveLength(1);
    expect(notifications[0].parentSessionId).toBe('parent-sess-1');
    expect(notifications[0].message).toContain('[Subagent "Test subagent" completed]');
    expect(notifications[0].message).toContain('Task completed successfully.');
    expect(notifications[0].message).toContain('subagent_read');
  });

  test('failed subagent notifies parent with error', async () => {
    const manager = new SubagentManager();
    const subagentId = 'sub-1';
    const state = makeState(subagentId);
    injectFakeSubagent(manager, subagentId, state);

    // Patch the fake session to simulate a failure.
    const managed = (manager as any).subagents.get(subagentId);
    managed.session.loadFromDb = async () => {};
    managed.session.persistUserMessage = () => 'msg-1';
    managed.session.runAgentLoop = async () => {
      throw new Error('API rate limit exceeded');
    };

    const notifications: { parentSessionId: string; message: string }[] = [];
    manager.onSubagentFinished = (parentSessionId, message) => {
      notifications.push({ parentSessionId, message });
    };

    const clientMessages: any[] = [];
    const sendToClient = (msg: ServerMessage) => clientMessages.push(msg);

    await (manager as any).runSubagent(subagentId, 'Do something', sendToClient);

    expect(state.status).toBe('failed');
    expect(state.error).toBe('API rate limit exceeded');
    expect(notifications).toHaveLength(1);
    expect(notifications[0].parentSessionId).toBe('parent-sess-1');
    expect(notifications[0].message).toContain('[Subagent "Test subagent" failed]');
    expect(notifications[0].message).toContain('API rate limit exceeded');
  });

  test('failed subagent does not notify if already aborted', async () => {
    const manager = new SubagentManager();
    const subagentId = 'sub-1';
    const state = makeState(subagentId, { status: 'aborted' });
    injectFakeSubagent(manager, subagentId, state);

    const managed = (manager as any).subagents.get(subagentId);
    managed.session.loadFromDb = async () => {};
    managed.session.persistUserMessage = () => 'msg-1';
    managed.session.runAgentLoop = async () => {
      throw new Error('Session aborted');
    };

    const notifications: { parentSessionId: string; message: string }[] = [];
    manager.onSubagentFinished = (parentSessionId, message) => {
      notifications.push({ parentSessionId, message });
    };

    await (manager as any).runSubagent(subagentId, 'Do something', () => {});

    // Should NOT notify — status was already terminal (aborted).
    expect(notifications).toHaveLength(0);
  });
});

describe('SubagentManager abortAllForParent', () => {
  test('aborts all active children of a parent', () => {
    const manager = new SubagentManager();
    injectFakeSubagent(manager, 'sub-1', makeState('sub-1'));
    injectFakeSubagent(manager, 'sub-2', makeState('sub-2'));
    injectFakeSubagent(manager, 'sub-3', makeState('sub-3', { status: 'completed' }));

    const notifications: string[] = [];
    manager.onSubagentFinished = (_pid, message) => notifications.push(message);

    const count = manager.abortAllForParent('parent-sess-1', () => {});

    expect(count).toBe(2); // sub-1 and sub-2, not sub-3 (already completed)
    expect(notifications).toHaveLength(2);
  });

  test('returns 0 for unknown parent', () => {
    const manager = new SubagentManager();
    const count = manager.abortAllForParent('nonexistent');
    expect(count).toBe(0);
  });
});

describe('SubagentManager sharedRequestTimestamps', () => {
  test('defaults to an empty array', () => {
    const manager = new SubagentManager();
    expect(manager.sharedRequestTimestamps).toEqual([]);
  });

  test('uses the assigned shared array (not a copy)', () => {
    const manager = new SubagentManager();
    const shared: number[] = [100, 200, 300];
    manager.sharedRequestTimestamps = shared;

    // Should be the same reference, so mutations are shared globally.
    expect(manager.sharedRequestTimestamps).toBe(shared);
    shared.push(400);
    expect(manager.sharedRequestTimestamps).toHaveLength(4);
  });
});

describe('SubagentManager abort race guard', () => {
  test('completed subagent does not notify if already aborted', async () => {
    const manager = new SubagentManager();
    const subagentId = 'sub-1';
    const state = makeState(subagentId, { status: 'aborted' });
    injectFakeSubagent(manager, subagentId, state);

    // Patch session to simulate successful completion after abort.
    const managed = (manager as any).subagents.get(subagentId);
    managed.session.loadFromDb = async () => {};
    managed.session.persistUserMessage = () => 'msg-1';
    managed.session.runAgentLoop = async () => {};
    managed.session.messages = [
      { role: 'assistant', content: [{ type: 'text', text: 'Done!' }] },
    ];

    const notifications: { parentSessionId: string; message: string }[] = [];
    manager.onSubagentFinished = (parentSessionId, message) => {
      notifications.push({ parentSessionId, message });
    };

    await (manager as any).runSubagent(subagentId, 'Do something', () => {});

    // Should NOT notify — status was already terminal (aborted) when loop finished.
    expect(notifications).toHaveLength(0);
    // Status should remain aborted, not overwritten to completed.
    expect(state.status).toBe('aborted');
  });
});
