/**
 * Tests that createToolExecutor propagates memoryScopeId from the session's
 * memory policy into the ToolContext passed to the underlying executor.
 */

import { describe, test, expect, mock } from 'bun:test';
import type { ToolExecutionResult, ToolContext } from '../tools/types.js';
import type { ToolSetupContext } from '../daemon/session-tool-setup.js';
import type { SurfaceType, SurfaceData } from '../daemon/ipc-protocol.js';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

mock.module('../daemon/session-surfaces.js', () => ({
  refreshSurfacesForApp: mock(() => {}),
  surfaceProxyResolver: mock(() => Promise.resolve({ content: '', isError: false })),
}));

mock.module('../services/published-app-updater.js', () => ({
  updatePublishedAppDeployment: mock(() => Promise.resolve()),
}));

mock.module('../tools/browser/browser-screencast.js', () => ({
  registerSessionSender: mock(() => {}),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { createToolExecutor } from '../daemon/session-tool-setup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ToolSetupContext> = {}): ToolSetupContext {
  return {
    conversationId: 'conv-scope',
    currentRequestId: 'req-1',
    workingDir: '/tmp/test',
    abortController: null,
    traceEmitter: { emit: () => {} },
    sendToClient: mock(() => {}),
    pendingSurfaceActions: new Map(),
    lastSurfaceAction: new Map(),
    surfaceState: new Map<string, { surfaceType: SurfaceType; data: SurfaceData }>(),
    surfaceUndoStacks: new Map(),
    currentTurnSurfaces: [],
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: false, requestId: 'r' }),
    getQueueDepth: () => 0,
    processMessage: async () => '',
    memoryPolicy: { scopeId: 'default', strictSideEffects: false },
    ...overrides,
  };
}

/** Executor spy that captures the ToolContext passed to execute(). */
function makeCapturingExecutor(result: ToolExecutionResult = { content: 'ok', isError: false }) {
  let captured: ToolContext | undefined;
  return {
    executor: {
      execute: mock(async (_name: string, _input: Record<string, unknown>, ctx: ToolContext) => {
        captured = ctx;
        return result;
      }),
    },
    getCaptured: () => captured,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noopPrompter = { prompt: mock(async () => ({ decision: 'allow' as const })) } as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noopSecretPrompter = { prompt: mock(async () => ({ cancelled: true })) } as any;
const noopLifecycleHandler = mock(() => {});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session-tool-setup memoryScopeId propagation', () => {
  test('passes default memoryScopeId to executor context', async () => {
    const ctx = makeCtx({ memoryPolicy: { scopeId: 'default', strictSideEffects: false } });
    const { executor, getCaptured } = makeCapturingExecutor();

    const toolFn = createToolExecutor(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      executor as any,
      noopPrompter,
      noopSecretPrompter,
      ctx,
      noopLifecycleHandler,
    );

    await toolFn('some_tool', { key: 'value' });

    expect(getCaptured()).toBeDefined();
    expect(getCaptured()!.memoryScopeId).toBe('default');
  });

  test('passes custom memoryScopeId from session memory policy', async () => {
    const ctx = makeCtx({ memoryPolicy: { scopeId: 'private-thread-abc', strictSideEffects: false } });
    const { executor, getCaptured } = makeCapturingExecutor();

    const toolFn = createToolExecutor(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      executor as any,
      noopPrompter,
      noopSecretPrompter,
      ctx,
      noopLifecycleHandler,
    );

    await toolFn('memory_write', { content: 'test' });

    expect(getCaptured()!.memoryScopeId).toBe('private-thread-abc');
  });

  test('reads memoryScopeId at call time, not construction time', async () => {
    const ctx = makeCtx({ memoryPolicy: { scopeId: 'initial', strictSideEffects: false } });
    const { executor, getCaptured } = makeCapturingExecutor();

    const toolFn = createToolExecutor(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      executor as any,
      noopPrompter,
      noopSecretPrompter,
      ctx,
      noopLifecycleHandler,
    );

    // Mutate the memory policy after construction
    ctx.memoryPolicy = { scopeId: 'updated-scope', strictSideEffects: false };

    await toolFn('some_tool', {});

    expect(getCaptured()!.memoryScopeId).toBe('updated-scope');
  });
});
