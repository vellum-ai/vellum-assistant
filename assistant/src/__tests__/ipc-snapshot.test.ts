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

type ClientMessageType = ClientMessage['type'];
const clientMessages: Record<ClientMessageType, ClientMessage> = {
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
    correlationId: 'corr-001',
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
    model: 'claude-opus-4-6',
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
  cu_session_create: {
    type: 'cu_session_create',
    sessionId: 'cu-sess-001',
    task: 'Open Safari and search for weather',
    screenWidth: 1920,
    screenHeight: 1080,
  },
  cu_session_abort: {
    type: 'cu_session_abort',
    sessionId: 'cu-sess-001',
  },
  cu_observation: {
    type: 'cu_observation',
    sessionId: 'cu-sess-001',
    axTree: '<ax-tree>...</ax-tree>',
    axDiff: '+ new element',
    secondaryWindows: 'Finder, Terminal',
    screenshot: 'base64-screenshot-data',
    executionResult: 'click completed',
  },
  ambient_observation: {
    type: 'ambient_observation',
    requestId: 'req-amb-001',
    ocrText: 'Hello world visible on screen',
    appName: 'Safari',
    windowTitle: 'Google',
    timestamp: 1700000000,
  },
  task_submit: {
    type: 'task_submit',
    task: 'Open Safari and search for weather',
    screenWidth: 1920,
    screenHeight: 1080,
  },
  ui_surface_action: {
    type: 'ui_surface_action',
    sessionId: 'sess-001',
    surfaceId: 'surface-001',
    actionId: 'btn-ok',
    data: { selectedItem: 'item-1' },
  },
  app_data_request: {
    type: 'app_data_request',
    surfaceId: 'surface-001',
    callId: 'call-001',
    method: 'query',
    appId: 'app-001',
  },
  skills_list: {
    type: 'skills_list',
  },
  skill_detail: {
    type: 'skill_detail',
    skillId: 'my-skill',
  },
  skills_enable: {
    type: 'skills_enable',
    name: 'my-skill',
  },
  skills_disable: {
    type: 'skills_disable',
    name: 'my-skill',
  },
  skills_configure: {
    type: 'skills_configure',
    name: 'my-skill',
    env: { API_KEY: 'test-key' },
    apiKey: 'sk-test',
    config: { verbose: true },
  },
  skills_install: {
    type: 'skills_install',
    slug: 'clawhub/my-skill',
    version: '1.0.0',
  },
  skills_uninstall: {
    type: 'skills_uninstall',
    name: 'my-skill',
  },
  skills_update: {
    type: 'skills_update',
    name: 'my-skill',
  },
  skills_check_updates: {
    type: 'skills_check_updates',
  },
  skills_search: {
    type: 'skills_search',
    query: 'weather',
  },
  skills_inspect: {
    type: 'skills_inspect',
    slug: 'clawhub/my-skill',
  },
  suggestion_request: {
    type: 'suggestion_request',
    sessionId: 'sess-001',
    requestId: 'req-suggest-001',
  },
  add_trust_rule: {
    type: 'add_trust_rule',
    toolName: 'bash',
    pattern: 'git *',
    scope: '/projects/my-app',
    decision: 'allow',
  },
  trust_rules_list: {
    type: 'trust_rules_list',
  },
  remove_trust_rule: {
    type: 'remove_trust_rule',
    id: 'rule-001',
  },
  update_trust_rule: {
    type: 'update_trust_rule',
    id: 'rule-001',
    tool: 'bash',
    pattern: 'git push *',
    scope: '/projects/my-app',
    decision: 'allow',
    priority: 50,
  },
  bundle_app: {
    type: 'bundle_app',
    appId: 'app-001',
  },
  apps_list: {
    type: 'apps_list',
  },
  shared_apps_list: {
    type: 'shared_apps_list',
  },
  shared_app_delete: {
    type: 'shared_app_delete',
    uuid: 'abc-123-def',
  },
  open_bundle: {
    type: 'open_bundle',
    filePath: '/tmp/My_App.vellumapp',
  },
  sign_bundle_payload_response: {
    type: 'sign_bundle_payload_response',
    signature: 'dGVzdC1zaWduYXR1cmU=',
    keyId: 'abc123',
    publicKey: 'dGVzdA==', // eslint-disable-line -- test fixture, not a real key
  },
  get_signing_identity_response: {
    type: 'get_signing_identity_response',
    keyId: 'abc123',
    publicKey: 'dGVzdA==', // eslint-disable-line -- test fixture, not a real key
  },
};

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

type ServerMessageType = ServerMessage['type'];
const serverMessages: Record<ServerMessageType, ServerMessage> = {
  assistant_text_delta: {
    type: 'assistant_text_delta',
    text: 'Here is some output',
    sessionId: 'sess-001',
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
      { label: 'Allow rm commands', description: 'Allow rm commands', pattern: 'bash:rm *' },
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
    sessionId: 'sess-001',
  },
  message_complete: {
    type: 'message_complete',
    sessionId: 'sess-001',
  },
  session_info: {
    type: 'session_info',
    sessionId: 'sess-001',
    title: 'My session',
    correlationId: 'corr-001',
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
  generation_handoff: {
    type: 'generation_handoff',
    sessionId: 'sess-001',
    requestId: 'req-handoff-001',
    queuedCount: 2,
  },
  model_info: {
    type: 'model_info',
    model: 'claude-opus-4-6',
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
    model: 'claude-opus-4-6',
  },
  usage_response: {
    type: 'usage_response',
    totalInputTokens: 1500,
    totalOutputTokens: 500,
    estimatedCost: 0.025,
    model: 'claude-opus-4-6',
  },
  context_compacted: {
    type: 'context_compacted',
    previousEstimatedInputTokens: 220000,
    estimatedInputTokens: 108000,
    maxInputTokens: 180000,
    thresholdTokens: 144000,
    compactedMessages: 56,
    summaryCalls: 3,
    summaryInputTokens: 4200,
    summaryOutputTokens: 900,
    summaryModel: 'claude-opus-4-6',
  },
  secret_detected: {
    type: 'secret_detected',
    toolName: 'bash',
    matches: [
      { type: 'api_key', redactedValue: 'sk-****abcd' },
    ],
    action: 'redact',
  },
  memory_recalled: {
    type: 'memory_recalled',
    provider: 'openai',
    model: 'text-embedding-3-small',
    lexicalHits: 12,
    semanticHits: 8,
    recencyHits: 6,
    entityHits: 3,
    mergedCount: 18,
    selectedCount: 10,
    rerankApplied: false,
    injectedTokens: 480,
    latencyMs: 55,
    topCandidates: [
      { key: 'segment:seg-1', type: 'segment', kind: 'fact', finalScore: 0.85, lexical: 0.9, semantic: 0.7, recency: 0.3 },
      { key: 'item:item-1', type: 'item', kind: 'preference', finalScore: 0.72, lexical: 0.6, semantic: 0.8, recency: 0.1 },
    ],
  },
  memory_status: {
    type: 'memory_status',
    enabled: true,
    degraded: false,
    provider: 'openai',
    model: 'text-embedding-3-small',
  },
  cu_action: {
    type: 'cu_action',
    sessionId: 'cu-sess-001',
    toolName: 'click',
    input: { x: 100, y: 200 },
    reasoning: 'Clicking the search button',
    stepNumber: 1,
  },
  cu_complete: {
    type: 'cu_complete',
    sessionId: 'cu-sess-001',
    summary: 'Successfully opened Safari and searched for weather',
    stepCount: 5,
  },
  cu_error: {
    type: 'cu_error',
    sessionId: 'cu-sess-001',
    message: 'Session timed out after 30 steps',
  },
  task_routed: {
    type: 'task_routed',
    sessionId: 'sess-routed-001',
    interactionType: 'computer_use',
  },
  ambient_result: {
    type: 'ambient_result',
    requestId: 'req-amb-001',
    decision: 'suggest',
    summary: 'User appears to be debugging a test failure',
    suggestion: 'Try running the test with --verbose flag for more details',
  },
  ui_surface_show: {
    type: 'ui_surface_show',
    sessionId: 'sess-001',
    surfaceId: 'surface-001',
    surfaceType: 'card',
    title: 'Status Update',
    data: { title: 'Build Complete', body: 'All tests passed.' },
    actions: [{ id: 'dismiss', label: 'OK', style: 'primary' }],
  },
  ui_surface_update: {
    type: 'ui_surface_update',
    sessionId: 'sess-001',
    surfaceId: 'surface-001',
    data: { body: 'Updated body text.' },
  },
  ui_surface_dismiss: {
    type: 'ui_surface_dismiss',
    sessionId: 'sess-001',
    surfaceId: 'surface-001',
  },
  app_data_response: {
    type: 'app_data_response',
    surfaceId: 'surface-001',
    callId: 'call-001',
    success: true,
    result: [{ id: 'rec-001', appId: 'app-001', data: { name: 'Test' }, createdAt: 1700000000, updatedAt: 1700000000 }],
  },
  skills_list_response: {
    type: 'skills_list_response',
    skills: [
      {
        id: 'my-skill',
        name: 'My Skill',
        description: 'A test skill',
        emoji: '🔧',
        source: 'bundled',
        state: 'enabled',
        degraded: false,
        updateAvailable: false,
        userInvocable: true,
      },
    ],
  },
  skills_state_changed: {
    type: 'skills_state_changed',
    name: 'my-skill',
    state: 'enabled',
  },
  skills_operation_response: {
    type: 'skills_operation_response',
    operation: 'enable',
    success: true,
  },
  skill_detail_response: {
    type: 'skill_detail_response',
    skillId: 'my-skill',
    body: '# Skill content\n\nDo the thing.',
  },
  skills_inspect_response: {
    type: 'skills_inspect_response',
    slug: 'clawhub/my-skill',
    data: {
      skill: { slug: 'clawhub/my-skill', displayName: 'My Skill', summary: 'A test skill' },
      owner: { handle: 'clawhub', displayName: 'ClaWHub' },
      stats: { stars: 42, installs: 1000, downloads: 5000, versions: 3 },
      createdAt: 1700000000,
      updatedAt: 1700001000,
      latestVersion: { version: '1.2.0', changelog: 'Bug fixes' },
      files: [{ path: 'SKILL.md', size: 1024 }],
      skillMdContent: '# My Skill\n\nDoes things.',
    },
  },
  suggestion_response: {
    type: 'suggestion_response',
    requestId: 'req-suggest-001',
    suggestion: 'Tell me more about that',
    source: 'llm',
  },
  message_queued: {
    type: 'message_queued',
    sessionId: 'sess-001',
    requestId: 'req-queue-001',
    position: 1,
  },
  message_dequeued: {
    type: 'message_dequeued',
    sessionId: 'sess-001',
    requestId: 'req-queue-001',
  },
  timer_completed: {
    type: 'timer_completed',
    sessionId: 'sess-001',
    timerId: 'tmr-001',
    label: 'Focus time',
    durationMinutes: 25,
  },
  trust_rules_list_response: {
    type: 'trust_rules_list_response',
    rules: [
      {
        id: 'rule-001',
        tool: 'bash',
        pattern: 'git *',
        scope: '/projects/my-app',
        decision: 'allow',
        priority: 100,
        createdAt: 1700000000,
      },
    ],
  },
  bundle_app_response: {
    type: 'bundle_app_response',
    bundlePath: '/tmp/My_App-abc12345.vellumapp',
    manifest: {
      format_version: 1,
      name: 'My App',
      description: 'A test app',
      created_at: '2026-01-01T00:00:00.000Z',
      created_by: 'vellum-assistant/0.1.6',
      entry: 'index.html',
      capabilities: [],
    },
  },
  apps_list_response: {
    type: 'apps_list_response',
    apps: [
      {
        id: 'app-001',
        name: 'My App',
        description: 'A test app',
        createdAt: 1700000000,
      },
    ],
  },
  shared_apps_list_response: {
    type: 'shared_apps_list_response',
    apps: [
      {
        uuid: 'abc-123-def',
        name: 'Shared App',
        description: 'A shared app',
        icon: '\u{1F4F1}',
        entry: 'index.html',
        trustTier: 'signed',
        signerDisplayName: 'Test User',
        bundleSizeBytes: 4096,
        installedAt: '2026-01-15T00:00:00Z',
      },
    ],
  },
  shared_app_delete_response: {
    type: 'shared_app_delete_response',
    success: true,
  },
  open_bundle_response: {
    type: 'open_bundle_response',
    manifest: {
      format_version: 1,
      name: 'My App',
      description: 'A test app',
      created_at: '2026-01-01T00:00:00.000Z',
      created_by: 'vellum-assistant/0.1.6',
      entry: 'index.html',
      capabilities: [],
    },
    scanResult: {
      passed: true,
      blocked: [],
      warnings: ['Use of fetch() detected'],
    },
    signatureResult: {
      trustTier: 'signed',
      signerKeyId: 'key-001',
      signerDisplayName: 'Test Signer',
      signerAccount: 'test@example.com',
    },
    bundleSizeBytes: 4096,
  },
  sign_bundle_payload: {
    type: 'sign_bundle_payload',
    payload: '{"content_hashes":{},"manifest":{}}',
  },
  get_signing_identity: {
    type: 'get_signing_identity',
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
