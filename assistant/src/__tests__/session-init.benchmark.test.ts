/**
 * Session Initialization Benchmark
 *
 * Measures latency of key session startup components and end-to-end
 * session creation timing (request to first-tool-ready state).
 *
 * Component targets:
 * - initializeTools: < 250ms
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
import type { AssistantDomainEvents } from '../events/domain-events.js';

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
const { EventBus } = await import('../events/bus.js');
const { registerToolMetricsLoggingListener } = await import('../events/tool-metrics-listener.js');
const { registerToolNotificationListener } = await import('../events/tool-notification-listener.js');
const { registerToolTraceListener } = await import('../events/tool-trace-listener.js');
const { registerToolProfilingListener, ToolProfiler } = await import('../events/tool-profiling-listener.js');
const { createToolAuditListener } = await import('../events/tool-audit-listener.js');
const { createToolDomainEventPublisher } = await import('../events/tool-domain-event-publisher.js');
const { buildToolDefinitions } = await import('../daemon/session-tool-setup.js');
const { projectSkillTools } = await import('../daemon/session-skill-tools.js');

function createTypedEventBus() {
  return new EventBus<AssistantDomainEvents>();
}

afterAll(() => {
  __resetRegistryForTesting();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    // best-effort cleanup
  }
});

describe('Session initialization benchmark', () => {
  test('initializeTools completes under 250ms', async () => {
    __resetRegistryForTesting();

    const start = performance.now();
    await initializeTools();
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(250);
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
  // Mirrors the real session creation path: tool init + system prompt +
  // tool definitions + event listener registration + skill projection.
  // This is what getOrCreateSession -> new Session() + loadFromDb() does.

  test('session creation without preactivated skills completes under 200ms', async () => {
    __resetRegistryForTesting();

    const start = performance.now();

    // Phase 1: Initialize tool registry (happens once per daemon, but
    // measured here as worst-case cold start)
    await initializeTools();

    // Phase 2: Build system prompt
    const systemPrompt = buildSystemPrompt();

    // Phase 3: Collect all tool definitions (core + UI surface + app proxy)
    const toolDefs = buildToolDefinitions();

    // Phase 4: Set up event bus and register all listeners
    const eventBus = createTypedEventBus();
    const noop = () => {};
    registerToolMetricsLoggingListener(eventBus);
    registerToolNotificationListener(eventBus, noop);
    registerToolTraceListener(eventBus, { emit: noop } as never);
    const profiler = new ToolProfiler();
    registerToolProfilingListener(eventBus, profiler);
    createToolAuditListener();
    createToolDomainEventPublisher(eventBus);

    const elapsed = performance.now() - start;

    // Validate outputs are meaningful
    expect(systemPrompt.length).toBeGreaterThan(0);
    expect(toolDefs.length).toBeGreaterThan(0);
    expect(eventBus.listenerCount()).toBeGreaterThan(0);

    expect(elapsed).toBeLessThan(200);

    eventBus.dispose();
  });

  test('session creation with 3 preactivated skills completes under 300ms', async () => {
    __resetRegistryForTesting();

    const start = performance.now();

    // Phase 1: Initialize tool registry
    await initializeTools();

    // Phase 2: Build system prompt
    const systemPrompt = buildSystemPrompt();

    // Phase 3: Collect tool definitions
    const toolDefs = buildToolDefinitions();

    // Phase 4: Event bus + listeners
    const eventBus = createTypedEventBus();
    const noop = () => {};
    registerToolMetricsLoggingListener(eventBus);
    registerToolNotificationListener(eventBus, noop);
    registerToolTraceListener(eventBus, { emit: noop } as never);
    const profiler = new ToolProfiler();
    registerToolProfilingListener(eventBus, profiler);
    createToolAuditListener();
    createToolDomainEventPublisher(eventBus);

    // Phase 5: Skill projection with preactivated skills
    const projection = projectSkillTools([], {
      preactivatedSkillIds: ['skill-a', 'skill-b', 'skill-c'],
    });

    const elapsed = performance.now() - start;

    expect(systemPrompt.length).toBeGreaterThan(0);
    expect(toolDefs.length).toBeGreaterThan(0);
    // Skill projection returns a result (may have 0 tools if skills
    // don't exist on disk, but the function itself must complete)
    expect(projection).toBeDefined();

    expect(elapsed).toBeLessThan(300);

    eventBus.dispose();
  });

  test('event listener registration completes under 10ms', () => {
    const start = performance.now();

    const eventBus = createTypedEventBus();
    const noop = () => {};
    registerToolMetricsLoggingListener(eventBus);
    registerToolNotificationListener(eventBus, noop);
    registerToolTraceListener(eventBus, { emit: noop } as never);
    const profiler = new ToolProfiler();
    registerToolProfilingListener(eventBus, profiler);
    createToolAuditListener();
    createToolDomainEventPublisher(eventBus);

    const elapsed = performance.now() - start;

    // Should have registered listeners for tool lifecycle events
    const totalListeners = eventBus.listenerCount() + eventBus.anyListenerCount();
    expect(totalListeners).toBeGreaterThan(0);

    expect(elapsed).toBeLessThan(10);

    eventBus.dispose();
  });
});
