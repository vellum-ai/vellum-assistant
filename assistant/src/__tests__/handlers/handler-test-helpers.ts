import { mock } from "bun:test";

import type { HandlerContext } from "../../daemon/handlers/shared.js";
import { DebouncerMap } from "../../util/debounce.js";

const noop = () => {};

/**
 * Create a test HandlerContext with a captured `sent` array.
 *
 * Pattern from recording-handler.test.ts:178-205.
 * Every handler test should use this instead of building its own.
 */
export function createTestHandlerContext(overrides?: Partial<HandlerContext>): {
  ctx: HandlerContext;
  sent: Array<{ type: string; [k: string]: unknown }>;
} {
  const sent: Array<{ type: string; [k: string]: unknown }> = [];

  const ctx: HandlerContext = {
    conversations: new Map(),
    sharedRequestTimestamps: [],
    debounceTimers: new DebouncerMap({ defaultDelayMs: 200 }),
    suppressConfigReload: false,
    setSuppressConfigReload: noop,
    updateConfigFingerprint: noop,
    send: (msg) => {
      sent.push(msg as { type: string; [k: string]: unknown });
    },
    broadcast: (msg) => {
      sent.push(msg as { type: string; [k: string]: unknown });
    },
    clearAllConversations: () => 0,
    getOrCreateConversation: async () => {
      throw new Error("not implemented");
    },
    touchConversation: noop,
    ...overrides,
  };

  return { ctx, sent };
}

/**
 * Create a minimal mock Conversation object for tests that need one
 * in the conversations Map or returned from getOrCreateConversation.
 *
 * Never construct a real Conversation in handler tests — the constructor
 * requires 20+ mocked modules and triggers side effects.
 */
export function createMockConversation(
  overrides: Record<string, unknown> = {},
) {
  return {
    setPreactivatedSkillIds: noop,
    setTurnChannelContext: noop,
    setTurnInterfaceContext: noop,
    setHostBashProxy: noop,
    setHostFileProxy: noop,
    setHostCuProxy: noop,
    addPreactivatedSkillId: noop,
    updateClient: noop,
    processMessage: mock(async () => {}),
    hasPendingConfirmation: () => false,
    hasPendingSecret: () => false,
    handleConfirmationResponse: mock(() => {}),
    handleSecretResponse: mock(() => {}),
    abort: mock(() => {}),
    undo: mock(() => 2),
    removeQueuedMessage: mock(() => true),
    isProcessing: () => false,
    dispose: mock(() => {}),
    markStale: mock(() => {}),
    headlessLock: false,
    trustContext: undefined,
    ...overrides,
  };
}

export const noopLogger = {
  info: noop,
  warn: noop,
  error: noop,
  debug: noop,
  trace: noop,
  fatal: noop,
  child: () => noopLogger,
};
