/**
 * Session Initialization Benchmark
 *
 * Measures latency of key session startup components and end-to-end
 * session creation timing (request to first-tool-ready state).
 *
 * Component targets:
 * - initializeTools: < 100ms
 * - buildSystemPrompt: < 50ms
 * - getAllToolDefinitions: < 10ms
 *
 * End-to-end targets:
 * - Session creation (no preactivated skills): < 200ms
 * - Session creation (3 preactivated skills): < 300ms
 * - Event listener registration: < 10ms
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'session-init-bench-'));

// Create subdirectories expected by platform helpers
mkdirSync(join(testDir, 'data'), { recursive: true });
mkdirSync(join(testDir, 'logs'), { recursive: true });
mkdirSync(join(testDir, 'skills'), { recursive: true });
mkdirSync(join(testDir, 'hooks'), { recursive: true });

// Seed minimal prompt files so buildSystemPrompt doesn't bail on missing files
writeFileSync(join(testDir, 'IDENTITY.md'), '# Test Identity\nYou are a test assistant.');
writeFileSync(join(testDir, 'SOUL.md'), '# Test Soul\nBe helpful.');
writeFileSync(join(testDir, 'USER.md'), '# Test User\nName: Benchmark Runner');

mock.module('../util/platform.js', () => ({
  getDataDir: () => testDir,
  getRootDir: () => testDir,
  getWorkspaceDir: () => testDir,
  getWorkspaceConfigPath: () => join(testDir, 'config.json'),
  getWorkspaceSkillsDir: () => join(testDir, 'skills'),
  getWorkspaceHooksDir: () => join(testDir, 'hooks'),
  getWorkspacePromptPath: (file: string) => join(testDir, file),
  getSocketPath: () => join(testDir, 'test.sock'),
  getSessionTokenPath: () => join(testDir, 'session-token'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'data', 'test.db'),
  getLogPath: () => join(testDir, 'logs', 'test.log'),
  getHistoryPath: () => join(testDir, 'history'),
  getHooksDir: () => join(testDir, 'hooks'),
  getIpcBlobDir: () => join(testDir, 'ipc-blobs'),
  getSandboxRootDir: () => join(testDir, 'sandbox'),
  getSandboxWorkingDir: () => testDir,
  getInterfacesDir: () => join(testDir, 'interfaces'),
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getPlatformName: () => process.platform,
  getClipboardCommand: () => null,
  removeSocketFile: () => {},
  migratePath: () => {},
  migrateToWorkspaceLayout: () => {},
  migrateToDataLayout: () => {},
  ensureDataDir: () => {},
}));

mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  getCliLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  isDebug: () => false,
  truncateForLog: (value: string, maxLen = 500) =>
    value.length > maxLen ? value.slice(0, maxLen) + '...' : value,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

const mockConfig = {
  model: 'mock-model',
  provider: 'mock',
  sandbox: { enabled: false, backend: 'native' },
  contextWindow: {
    enabled: true,
    maxInputTokens: 180000,
    targetInputTokens: 110000,
    compactThreshold: 0.8,
    preserveRecentUserTurns: 8,
    summaryMaxTokens: 1200,
  },
  thinking: { enabled: false, budgetTokens: 10000 },
};

mock.module('../config/loader.js', () => ({
  API_KEY_PROVIDERS: ['anthropic', 'openai', 'gemini', 'ollama', 'fireworks', 'brave', 'perplexity'],
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  saveConfig: () => {},
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

// Additional mocks required for Session constructor and end-to-end tests

mock.module('../memory/conversation-store.js', () => ({
  addMessage: () => ({ id: 'msg-1' }),
  getMessages: () => [],
  listConversations: () => [],
  getConversation: () => null,
  getLatestConversation: () => null,
  createConversation: () => ({ id: 'bench-conv', title: 'Bench', threadType: 'standard' }),
  clearAll: () => {},
  getConversationThreadType: () => 'standard',
  getConversationMemoryScopeId: () => 'default',
  updateConversationTitle: () => {},
}));

mock.module('../hooks/manager.js', () => ({
  getHookManager: () => ({
    trigger: () => Promise.resolve(),
    initialize: () => {},
  }),
}));

mock.module('../tools/watch/watch-state.js', () => ({
  watchSessions: new Map(),
  registerWatchStartNotifier: () => {},
  unregisterWatchStartNotifier: () => {},
  fireWatchStartNotifier: () => {},
  registerWatchCommentaryNotifier: () => {},
  unregisterWatchCommentaryNotifier: () => {},
  fireWatchCommentaryNotifier: () => {},
  registerWatchCompletionNotifier: () => {},
  unregisterWatchCompletionNotifier: () => {},
  fireWatchCompletionNotifier: () => {},
  getActiveWatchSession: () => undefined,
  addObservation: () => {},
  pruneWatchSessions: () => {},
}));

mock.module('../calls/call-state.js', () => ({
  registerCallQuestionNotifier: () => {},
  unregisterCallQuestionNotifier: () => {},
  fireCallQuestionNotifier: () => {},
  registerCallCompletionNotifier: () => {},
  unregisterCallCompletionNotifier: () => {},
  fireCallCompletionNotifier: () => {},
  registerCallOrchestrator: () => {},
  unregisterCallOrchestrator: () => {},
  getCallOrchestrator: () => undefined,
}));

mock.module('../calls/call-store.js', () => ({
  createCallSession: () => ({ id: 'mock' }),
  getCallSession: () => null,
  getCallSessionByCallSid: () => null,
  getActiveCallSessionForConversation: () => null,
  updateCallSession: () => {},
  listRecoverableCalls: () => [],
  recordCallEvent: () => {},
  getCallEvents: () => [],
  createPendingQuestion: () => ({ id: 'mock' }),
  getPendingQuestion: () => null,
  answerPendingQuestion: () => {},
  expirePendingQuestions: () => {},
  buildCallbackDedupeKey: () => '',
  isCallbackProcessed: () => false,
  recordProcessedCallback: () => {},
  tryRecordProcessedCallback: () => true,
}));

mock.module('../daemon/watch-handler.js', () => ({
  lastCommentaryBySession: new Map(),
  lastSummaryBySession: new Map(),
}));

mock.module('../tools/browser/browser-screencast.js', () => ({
  registerSessionSender: () => {},
  unregisterSessionSender: () => {},
  ensureScreencast: () => Promise.resolve(),
  updateBrowserStatus: () => {},
  updatePagesList: () => Promise.resolve(),
  stopBrowserScreencast: () => Promise.resolve(),
  getElementBounds: () => Promise.resolve(null),
  updateHighlights: () => {},
  stopAllScreencasts: () => Promise.resolve(),
  isScreencastActive: () => false,
  getSender: () => undefined,
  getScreencastSurfaceId: () => null,
}));

mock.module('../services/published-app-updater.js', () => ({
  updatePublishedAppDeployment: () => Promise.resolve(),
}));

const { initializeTools, getAllToolDefinitions, __resetRegistryForTesting } = await import(
  '../tools/registry.js'
);
const { buildSystemPrompt } = await import('../config/system-prompt.js');
const { Session } = await import('../daemon/session.js');
import type { Provider } from '../providers/types.js';

afterAll(() => {
  __resetRegistryForTesting();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    // best-effort cleanup
  }
});

describe('Session initialization benchmark', () => {
  test('initializeTools completes under 100ms', async () => {
    __resetRegistryForTesting();

    const start = performance.now();
    await initializeTools();
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(100);
  });

  test('getAllToolDefinitions retrieves definitions under 10ms', async () => {
    // Ensure tools are initialized first
    await initializeTools();

    const start = performance.now();
    const definitions = getAllToolDefinitions();
    const elapsed = performance.now() - start;

    expect(definitions.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(10);
  });

  test('buildSystemPrompt assembles prompt under 50ms', () => {
    const start = performance.now();
    const prompt = buildSystemPrompt();
    const elapsed = performance.now() - start;

    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('Test Identity');
    expect(elapsed).toBeLessThan(50);
  });

  test('repeated buildSystemPrompt calls are consistently fast (10 iterations)', () => {
    const timings: number[] = [];
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      buildSystemPrompt();
      timings.push(performance.now() - start);
    }

    const maxTime = Math.max(...timings);
    const avgTime = timings.reduce((a, b) => a + b, 0) / timings.length;

    // Each call should be under 50ms, average well under 20ms
    expect(maxTime).toBeLessThan(50);
    expect(avgTime).toBeLessThan(20);
  });

  test('tool definitions count stays within expected range after init', async () => {
    await initializeTools();
    const definitions = getAllToolDefinitions();

    // Sanity: we expect a meaningful number of core tools (at least 20)
    // but not an unreasonable explosion (under 200)
    expect(definitions.length).toBeGreaterThanOrEqual(20);
    expect(definitions.length).toBeLessThan(200);
  });
});

describe('End-to-end session creation benchmark', () => {
  // Uses the real Session constructor + loadFromDb() path, which wires up
  // the tool executor, event bus, agent loop, context window manager, and
  // notifiers — exactly what the daemon does.

  const mockProvider: Provider = {
    name: 'mock',
    sendMessage: () =>
      Promise.resolve({
        content: [{ type: 'text' as const, text: 'ok' }],
        model: 'mock-model',
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: 'end_turn',
      }),
  };
  const noop = () => {};

  test('session creation without preactivated skills completes under 200ms', async () => {
    __resetRegistryForTesting();
    await initializeTools();
    const systemPrompt = buildSystemPrompt();

    const start = performance.now();

    const session = new Session(
      'bench-no-skills',
      mockProvider,
      systemPrompt,
      64000,
      noop,
      testDir,
    );
    await session.loadFromDb();

    const elapsed = performance.now() - start;

    expect(session.conversationId).toBe('bench-no-skills');
    expect(session.getMessages()).toHaveLength(0);

    expect(elapsed).toBeLessThan(200);

    session.dispose();
  });

  test('session creation with 3 preactivated skills completes under 300ms', async () => {
    __resetRegistryForTesting();
    await initializeTools();
    const systemPrompt = buildSystemPrompt();

    const start = performance.now();

    const session = new Session(
      'bench-with-skills',
      mockProvider,
      systemPrompt,
      64000,
      noop,
      testDir,
    );
    // Simulate preactivated skills the same way the daemon does
    session.preactivatedSkillIds = ['skill-a', 'skill-b', 'skill-c'];
    await session.loadFromDb();

    const elapsed = performance.now() - start;

    expect(session.conversationId).toBe('bench-with-skills');
    expect(session.getMessages()).toHaveLength(0);

    expect(elapsed).toBeLessThan(300);

    session.dispose();
  });

  test('event listener registration is included in constructor and completes under 10ms', () => {
    // The Session constructor registers all event listeners internally.
    // Verify the event bus has listeners after construction.
    const systemPrompt = buildSystemPrompt();

    const start = performance.now();

    const session = new Session(
      'bench-events',
      mockProvider,
      systemPrompt,
      64000,
      noop,
      testDir,
    );

    const elapsed = performance.now() - start;

    // The constructor wires up metrics, notification, trace, profiling,
    // audit, and domain-event listeners — verify at least some exist
    expect(session.eventBus.listenerCount()).toBeGreaterThan(0);

    expect(elapsed).toBeLessThan(10);

    session.dispose();
  });
});
