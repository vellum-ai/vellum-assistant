import * as net from 'node:net';

import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { HandlerContext } from '../daemon/handlers.js';
import type { UserMessage } from '../daemon/ipc-contract.js';
import type { ServerMessage } from '../daemon/ipc-protocol.js';
import { DebouncerMap } from '../util/debounce.js';

const routeGuardianReplyMock = mock(async () => ({
  consumed: false,
  decisionApplied: false,
  type: 'not_consumed' as const,
})) as any;
const listPendingByDestinationMock = mock(() => [] as Array<{ id: string }>);
const listCanonicalMock = mock(() => [] as Array<{ id: string }>);
const addMessageMock = mock(async () => ({ id: 'persisted-message-id' }));
const getConfigMock = mock(() => ({
  daemon: { standaloneRecording: false },
  secretDetection: { customPatterns: [], entropyThreshold: 3.5 },
}));

mock.module('../runtime/guardian-reply-router.js', () => ({
  routeGuardianReply: routeGuardianReplyMock,
}));

mock.module('../memory/canonical-guardian-store.js', () => ({
  listPendingCanonicalGuardianRequestsByDestinationConversation: listPendingByDestinationMock,
  listCanonicalGuardianRequests: listCanonicalMock,
}));

mock.module('../memory/conversation-store.js', () => ({
  addMessage: addMessageMock,
}));

mock.module('../config/loader.js', () => ({
  getConfig: getConfigMock,
}));

mock.module('../daemon/approval-generators.js', () => ({
  createApprovalConversationGenerator: () => async () => ({
    disposition: 'keep_pending',
    replyText: 'pending',
  }),
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
}));

import { handleUserMessage } from '../daemon/handlers/sessions.js';

interface TestSession {
  hasEscalationHandler: () => boolean;
  setChannelCapabilities: (caps: unknown) => void;
  hasAnyPendingConfirmation: () => boolean;
  getQueueDepth: () => number;
  denyAllPendingConfirmations: () => void;
  enqueueMessage: (...args: unknown[]) => { queued: boolean; rejected?: boolean; requestId: string };
  traceEmitter: { emit: (...args: unknown[]) => void };
  setTurnChannelContext: (ctx: unknown) => void;
  setTurnInterfaceContext: (ctx: unknown) => void;
  setAssistantId: (assistantId: string) => void;
  setGuardianContext: (ctx: unknown) => void;
  setCommandIntent: (intent: unknown) => void;
  processMessage: (...args: unknown[]) => Promise<string>;
}

function createContext(session: TestSession): { ctx: HandlerContext; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  const ctx: HandlerContext = {
    sessions: new Map(),
    socketToSession: new Map(),
    cuSessions: new Map(),
    socketToCuSession: new Map(),
    cuObservationParseSequence: new Map(),
    socketSandboxOverride: new Map(),
    sharedRequestTimestamps: [],
    debounceTimers: new DebouncerMap({ defaultDelayMs: 100 }),
    suppressConfigReload: false,
    setSuppressConfigReload: () => {},
    updateConfigFingerprint: () => {},
    send: (_socket, msg) => { sent.push(msg); },
    broadcast: () => {},
    clearAllSessions: () => 0,
    getOrCreateSession: async () => session as any,
    touchSession: () => {},
  };
  return { ctx, sent };
}

function makeMessage(content: string): UserMessage {
  return {
    type: 'user_message',
    sessionId: 'conv-1',
    content,
    channel: 'vellum',
    interface: 'macos',
  };
}

function makeSession(overrides: Partial<TestSession> = {}): TestSession {
  return {
    hasEscalationHandler: () => true,
    setChannelCapabilities: () => {},
    hasAnyPendingConfirmation: () => true,
    getQueueDepth: () => 0,
    denyAllPendingConfirmations: mock(() => {}),
    enqueueMessage: mock(() => ({ queued: true, requestId: 'queued-id' })),
    traceEmitter: { emit: () => {} },
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    setAssistantId: () => {},
    setGuardianContext: () => {},
    setCommandIntent: () => {},
    processMessage: async () => 'msg-id',
    ...overrides,
  };
}

describe('handleUserMessage pending-confirmation reply interception', () => {
  beforeEach(() => {
    routeGuardianReplyMock.mockClear();
    listPendingByDestinationMock.mockClear();
    listCanonicalMock.mockClear();
    addMessageMock.mockClear();
    getConfigMock.mockClear();
  });

  test('consumes decision replies before auto-deny', async () => {
    listPendingByDestinationMock.mockReturnValue([{ id: 'req-1' }]);
    listCanonicalMock.mockReturnValue([{ id: 'req-1' }]);
    routeGuardianReplyMock.mockResolvedValue({
      consumed: true,
      decisionApplied: true,
      type: 'canonical_decision_applied',
      requestId: 'req-1',
    });

    const session = makeSession();
    const { ctx, sent } = createContext(session);

    await handleUserMessage(makeMessage('go for it'), {} as net.Socket, ctx);

    expect(routeGuardianReplyMock).toHaveBeenCalledTimes(1);
    const routeCall = (routeGuardianReplyMock as any).mock.calls[0][0] as Record<string, unknown>;
    expect(routeCall.messageText).toBe('go for it');
    expect(typeof routeCall.approvalConversationGenerator).toBe('function');
    expect((session.denyAllPendingConfirmations as any).mock.calls.length).toBe(0);
    expect((session.enqueueMessage as any).mock.calls.length).toBe(0);
    expect(addMessageMock).toHaveBeenCalledTimes(2);
    expect(addMessageMock).toHaveBeenCalledWith(
      'conv-1',
      'user',
      expect.any(String),
      expect.objectContaining({
        userMessageChannel: 'vellum',
        assistantMessageChannel: 'vellum',
        userMessageInterface: 'macos',
        assistantMessageInterface: 'macos',
        provenanceActorRole: 'guardian',
      }),
    );
    expect(addMessageMock).toHaveBeenCalledWith(
      'conv-1',
      'assistant',
      expect.stringContaining('Decision applied.'),
      expect.objectContaining({
        userMessageChannel: 'vellum',
        assistantMessageChannel: 'vellum',
        userMessageInterface: 'macos',
        assistantMessageInterface: 'macos',
        provenanceActorRole: 'guardian',
      }),
    );
    expect(sent.map((msg) => msg.type)).toEqual([
      'message_queued',
      'message_dequeued',
      'assistant_text_delta',
      'message_complete',
    ]);
    const assistantDelta = sent.find(
      (msg): msg is Extract<ServerMessage, { type: 'assistant_text_delta' }> => msg.type === 'assistant_text_delta',
    );
    expect(assistantDelta?.text).toBe('Decision applied.');
  });

  test('nl keep_pending falls back to existing auto-deny + queue behavior', async () => {
    listPendingByDestinationMock.mockReturnValue([{ id: 'req-1' }]);
    listCanonicalMock.mockReturnValue([{ id: 'req-1' }]);
    routeGuardianReplyMock.mockResolvedValue({
      consumed: true,
      decisionApplied: false,
      type: 'nl_keep_pending',
      requestId: 'req-1',
      replyText: 'Need clarification',
    });

    const session = makeSession();
    const { ctx, sent } = createContext(session);

    await handleUserMessage(makeMessage('what does that do?'), {} as net.Socket, ctx);

    expect(routeGuardianReplyMock).toHaveBeenCalledTimes(1);
    expect((session.denyAllPendingConfirmations as any).mock.calls.length).toBe(1);
    expect((session.enqueueMessage as any).mock.calls.length).toBe(1);
    expect(addMessageMock).toHaveBeenCalledTimes(0);
    expect(sent.some((msg) => msg.type === 'message_queued')).toBe(true);
    expect(sent.some((msg) => msg.type === 'message_dequeued')).toBe(false);
  });
});
