import * as net from 'node:net';

import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { HandlerContext } from '../daemon/handlers.js';
import type { ConfirmationResponse, UserMessage } from '../daemon/ipc-contract.js';
import type { ServerMessage } from '../daemon/ipc-protocol.js';
import { DebouncerMap } from '../util/debounce.js';

const routeGuardianReplyMock = mock(async () => ({
  consumed: false,
  decisionApplied: false,
  type: 'not_consumed' as const,
})) as any;
const createCanonicalGuardianRequestMock = mock(() => ({
  id: 'canonical-id',
}));
const generateCanonicalRequestCodeMock = mock(() => 'ABC123');
const listPendingByDestinationMock = mock(() => [] as Array<{ id: string; kind?: string }>);
const listCanonicalMock = mock(() => [] as Array<{ id: string }>);
const resolveCanonicalGuardianRequestMock = mock(() => null as { id: string } | null);
const getByConversationMock = mock(
  () => [] as Array<{
    requestId: string;
    kind: 'confirmation' | 'secret';
    session?: unknown;
  }>,
);
const registerMock = mock(() => {});
const resolveMock = mock(() => undefined as unknown);
const addMessageMock = mock(async () => ({ id: 'persisted-message-id' }));
const getConfigMock = mock(() => ({
  daemon: { standaloneRecording: false },
  secretDetection: { customPatterns: [], entropyThreshold: 3.5 },
}));

mock.module('../runtime/guardian-reply-router.js', () => ({
  routeGuardianReply: routeGuardianReplyMock,
}));

mock.module('../memory/canonical-guardian-store.js', () => ({
  createCanonicalGuardianRequest: createCanonicalGuardianRequestMock,
  generateCanonicalRequestCode: generateCanonicalRequestCodeMock,
  listPendingCanonicalGuardianRequestsByDestinationConversation: listPendingByDestinationMock,
  listCanonicalGuardianRequests: listCanonicalMock,
  resolveCanonicalGuardianRequest: resolveCanonicalGuardianRequestMock,
}));

mock.module('../runtime/pending-interactions.js', () => ({
  register: registerMock,
  getByConversation: getByConversationMock,
  resolve: resolveMock,
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

import { handleConfirmationResponse, handleUserMessage } from '../daemon/handlers/sessions.js';

interface TestSession {
  messages: Array<{ role: string; content: unknown[] }>;
  hasEscalationHandler: () => boolean;
  setChannelCapabilities: (caps: unknown) => void;
  isProcessing: () => boolean;
  hasPendingConfirmation: (requestId: string) => boolean;
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
    messages: [],
    hasEscalationHandler: () => true,
    setChannelCapabilities: () => {},
    isProcessing: () => false,
    hasPendingConfirmation: () => true,
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
    createCanonicalGuardianRequestMock.mockClear();
    generateCanonicalRequestCodeMock.mockClear();
    listPendingByDestinationMock.mockClear();
    listCanonicalMock.mockClear();
    resolveCanonicalGuardianRequestMock.mockClear();
    registerMock.mockClear();
    getByConversationMock.mockClear();
    resolveMock.mockClear();
    addMessageMock.mockClear();
    getConfigMock.mockClear();
  });

  test('consumes decision replies before auto-deny', async () => {
    listPendingByDestinationMock.mockReturnValue([{ id: 'req-1', kind: 'tool_approval' }]);
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
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]?.role).toBe('user');
    expect(session.messages[1]?.role).toBe('assistant');
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
      'message_request_complete',
    ]);
    const assistantDelta = sent.find(
      (msg): msg is Extract<ServerMessage, { type: 'assistant_text_delta' }> => msg.type === 'assistant_text_delta',
    );
    expect(assistantDelta?.text).toBe('Decision applied.');
    const requestComplete = sent.find(
      (msg): msg is Extract<ServerMessage, { type: 'message_request_complete' }> => msg.type === 'message_request_complete',
    );
    expect(requestComplete?.runStillActive).toBe(false);
  });

  test('does not mutate in-memory history while processing', async () => {
    listPendingByDestinationMock.mockReturnValue([{ id: 'req-1', kind: 'tool_approval' }]);
    listCanonicalMock.mockReturnValue([{ id: 'req-1' }]);
    routeGuardianReplyMock.mockResolvedValue({
      consumed: true,
      decisionApplied: true,
      type: 'canonical_decision_applied',
      requestId: 'req-1',
    });

    const session = makeSession({ isProcessing: () => true });
    const { ctx, sent } = createContext(session);

    await handleUserMessage(makeMessage('approve'), {} as net.Socket, ctx);

    expect(addMessageMock).toHaveBeenCalledTimes(2);
    expect(session.messages).toHaveLength(0);
    // assistant_text_delta must NOT be sent when the session is processing —
    // it would contaminate the agent's in-flight streaming message on the client.
    expect(sent.some((msg) => msg.type === 'assistant_text_delta')).toBe(false);
    expect(sent.map((msg) => msg.type)).toEqual([
      'message_queued',
      'message_dequeued',
      'message_request_complete',
    ]);
    const requestComplete = sent.find(
      (msg): msg is Extract<ServerMessage, { type: 'message_request_complete' }> => msg.type === 'message_request_complete',
    );
    expect(requestComplete?.runStillActive).toBe(true);
  });

  test('nl keep_pending falls back to existing auto-deny + queue behavior', async () => {
    listPendingByDestinationMock.mockReturnValue([{ id: 'req-1', kind: 'tool_approval' }]);
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
    expect(session.messages).toHaveLength(0);
    expect(addMessageMock).toHaveBeenCalledTimes(0);
    expect(sent.some((msg) => msg.type === 'message_queued')).toBe(true);
    expect(sent.some((msg) => msg.type === 'message_dequeued')).toBe(false);
  });

  test('routes only live pending confirmation request ids', async () => {
    const session = makeSession({
      hasPendingConfirmation: (requestId: string) => requestId === 'req-live',
    });

    getByConversationMock.mockReturnValue([
      { requestId: 'req-stale', kind: 'confirmation', session: {} },
      { requestId: 'req-live', kind: 'confirmation', session: session as unknown },
    ]);
    listPendingByDestinationMock.mockReturnValue([
      { id: 'req-stale', kind: 'tool_approval' },
      { id: 'req-live', kind: 'tool_approval' },
    ]);
    listCanonicalMock.mockReturnValue([
      { id: 'req-stale' },
      { id: 'req-live' },
    ]);
    routeGuardianReplyMock.mockResolvedValue({
      consumed: false,
      decisionApplied: false,
      type: 'not_consumed',
    });

    const { ctx } = createContext(session);
    await handleUserMessage(makeMessage('allow'), {} as net.Socket, ctx);

    expect(routeGuardianReplyMock).toHaveBeenCalledTimes(1);
    const routeCall = (routeGuardianReplyMock as any).mock.calls[0][0] as Record<string, unknown>;
    expect(routeCall.pendingRequestIds).toEqual(['req-live']);
    // Auto-deny clears matching confirmation entries from pending-interactions
    // so stale IDs are not reused as routing candidates. Only the live
    // session-scoped interaction should be resolved.
    expect(resolveMock).toHaveBeenCalledTimes(1);
    expect(resolveMock).toHaveBeenCalledWith('req-live');
  });

  test('registers IPC confirmation events for NL approval routing', async () => {
    const session = makeSession({
      hasAnyPendingConfirmation: () => false,
      enqueueMessage: mock(() => ({ queued: false, requestId: 'direct-id' })),
      processMessage: async (_content, _attachments, onEvent) => {
        (onEvent as (msg: ServerMessage) => void)({
          type: 'confirmation_request',
          requestId: 'req-confirm-1',
          toolName: 'call_start',
          input: { phone_number: '+18084436762' },
          riskLevel: 'high',
          executionTarget: 'host',
          allowlistOptions: [],
          scopeOptions: [],
          persistentDecisionsAllowed: false,
        } as ServerMessage);
        return 'msg-id';
      },
    });
    const { ctx, sent } = createContext(session);

    await handleUserMessage(makeMessage('please call now'), {} as net.Socket, ctx);

    expect(registerMock).toHaveBeenCalledTimes(1);
    expect(registerMock).toHaveBeenCalledWith(
      'req-confirm-1',
      expect.objectContaining({
        conversationId: 'conv-1',
        kind: 'confirmation',
        session,
        confirmationDetails: expect.objectContaining({
          toolName: 'call_start',
          riskLevel: 'high',
          executionTarget: 'host',
        }),
      }),
    );
    expect(createCanonicalGuardianRequestMock).toHaveBeenCalledTimes(1);
    expect(createCanonicalGuardianRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'req-confirm-1',
        kind: 'tool_approval',
        sourceType: 'desktop',
        sourceChannel: 'vellum',
        conversationId: 'conv-1',
        toolName: 'call_start',
        status: 'pending',
        requestCode: 'ABC123',
      }),
    );
    expect(sent.some((event) => event.type === 'confirmation_request')).toBe(true);
  });

  test('syncs canonical status to approved for IPC allow decisions', () => {
    const session = {
      hasPendingConfirmation: (requestId: string) => requestId === 'req-confirm-allow',
      handleConfirmationResponse: mock(() => {}),
    };
    const { ctx } = createContext(makeSession());
    ctx.sessions.set('conv-1', session as any);

    const msg: ConfirmationResponse = {
      type: 'confirmation_response',
      requestId: 'req-confirm-allow',
      decision: 'always_allow',
    };

    handleConfirmationResponse(msg, {} as net.Socket, ctx);

    expect((session.handleConfirmationResponse as any).mock.calls.length).toBe(1);
    expect((session.handleConfirmationResponse as any).mock.calls[0]).toEqual([
      'req-confirm-allow',
      'always_allow',
      undefined,
      undefined,
    ]);
    expect(resolveCanonicalGuardianRequestMock).toHaveBeenCalledWith(
      'req-confirm-allow',
      'pending',
      { status: 'approved' },
    );
    expect(resolveMock).toHaveBeenCalledWith('req-confirm-allow');
  });

  test('syncs canonical status to denied for IPC deny decisions in CU sessions', () => {
    const cuSession = {
      hasPendingConfirmation: (requestId: string) => requestId === 'req-confirm-deny',
      handleConfirmationResponse: mock(() => {}),
    };
    const { ctx } = createContext(makeSession({
      hasPendingConfirmation: () => false,
    }));
    ctx.cuSessions.set('cu-1', cuSession as any);

    const msg: ConfirmationResponse = {
      type: 'confirmation_response',
      requestId: 'req-confirm-deny',
      decision: 'always_deny',
    };

    handleConfirmationResponse(msg, {} as net.Socket, ctx);

    expect((cuSession.handleConfirmationResponse as any).mock.calls.length).toBe(1);
    expect((cuSession.handleConfirmationResponse as any).mock.calls[0]).toEqual([
      'req-confirm-deny',
      'always_deny',
      undefined,
      undefined,
    ]);
    expect(resolveCanonicalGuardianRequestMock).toHaveBeenCalledWith(
      'req-confirm-deny',
      'pending',
      { status: 'denied' },
    );
    expect(resolveMock).toHaveBeenCalledWith('req-confirm-deny');
  });
});
