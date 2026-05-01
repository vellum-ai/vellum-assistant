import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../memory/attachments-store.js", () => ({
  getAttachmentsByIds: () => [],
  getSourcePathsForAttachments: () => new Map<string, string>(),
}));

mock.module("../memory/canonical-guardian-store.js", () => ({
  createCanonicalGuardianRequest: () => ({
    id: "canonical-id",
    requestCode: "ABC123",
  }),
  generateCanonicalRequestCode: () => "ABC123",
}));

mock.module("../memory/conversation-crud.js", () => ({
  addMessage: async () => ({ id: "message-id" }),
  getConversation: () => null,
  provenanceFromTrustContext: () => ({}),
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
}));

mock.module("../memory/conversation-disk-view.js", () => ({
  updateMetaFile: () => {},
}));

mock.module("../runtime/confirmation-request-guardian-bridge.js", () => ({
  bridgeConfirmationRequestToGuardian: () => {},
}));

mock.module("../runtime/pending-interactions.js", () => ({
  register: () => {},
  resolve: () => {},
}));

mock.module("../security/secret-scanner.js", () => ({
  redactSecrets: (value: string) => value,
}));

mock.module("../tools/tool-input-summary.js", () => ({
  summarizeToolInput: () => "",
}));

mock.module("../daemon/conversation-runtime-assembly.js", () => ({
  resolveChannelCapabilities: () => ({
    channel: "slack",
    dashboardCapable: false,
    supportsDynamicUi: false,
    supportsVoiceInput: false,
    chatType: "channel",
  }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    llm: {
      default: {
        provider: "mock-provider",
        model: "mock-model",
        contextWindow: { maxInputTokens: 100000 },
      },
    },
  }),
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (err: unknown) => void;
};
type PersistUserMessageMock = ReturnType<
  typeof mock<
    (
      content: string,
      attachments: unknown[],
      requestId?: string,
      metadata?: Record<string, unknown>,
    ) => Promise<string>
  >
>;
type RunAgentLoopMock = ReturnType<
  typeof mock<(...args: unknown[]) => Promise<void>>
>;
type NoticeMock = ReturnType<typeof mock<(notice: string | undefined) => void>>;
interface TestConversation {
  conversationId: string;
  trustContext: unknown;
  authContext: unknown;
  assistantId: string | undefined;
  taskRunId: string | undefined;
  isProcessing: () => boolean;
  setAssistantId: (assistantId: string) => void;
  setTrustContext: (ctx: unknown) => void;
  setAuthContext: (ctx: unknown) => void;
  ensureActorScopedHistory: () => Promise<void>;
  setChannelCapabilities: () => void;
  setHostCuProxy: () => void;
  addPreactivatedSkillId: () => void;
  setCommandIntent: () => void;
  setTurnChannelContext: (ctx: TurnChannelContext) => void;
  getTurnChannelContext: () => TurnChannelContext | null;
  setTurnInterfaceContext: (ctx: TurnInterfaceContext) => void;
  getTurnInterfaceContext: () => TurnInterfaceContext | null;
  getMessages: () => unknown[];
  usageStats: {
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
  };
  persistUserMessage: PersistUserMessageMock;
  setSlackRuntimeContextNotice: NoticeMock;
  runAgentLoop: RunAgentLoopMock;
  updateClient: (sender: (...args: unknown[]) => void) => void;
  getCurrentSender: () => ((...args: unknown[]) => void) | undefined;
  __loopDeferred: Deferred<void>;
  __noticeCalls: Array<string | undefined>;
  __loopNotices: Array<string | undefined>;
  __clientSenders: Array<((...args: unknown[]) => void) | undefined>;
}

let activeConversation: TestConversation;
const mergeConversationOptionsMock = mock(() => {});

mock.module("../daemon/conversation-store.js", () => ({
  getOrCreateConversation: async () => activeConversation,
  mergeConversationOptions: mergeConversationOptionsMock,
}));

import type {
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import {
  processMessage,
  processMessageInBackground,
} from "../daemon/process-message.js";

function createDeferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForRunAgentLoopCall(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    if (activeConversation.runAgentLoop.mock.calls.length > 0) return;
    await Promise.resolve();
  }
}

function makeConversation(): TestConversation {
  let turnChannelContext: TurnChannelContext | null = null;
  let turnInterfaceContext: TurnInterfaceContext | null = null;
  let slackNotice: string | undefined;
  let currentSender: ((...args: unknown[]) => void) | undefined;
  const noticeCalls: Array<string | undefined> = [];
  const loopDeferred = createDeferred<void>();
  const loopNotices: Array<string | undefined> = [];
  const clientSenders: Array<((...args: unknown[]) => void) | undefined> = [];
  const messages: unknown[] = [];

  const conversation: TestConversation = {
    conversationId: "conv-background-slack",
    trustContext: undefined,
    authContext: undefined,
    assistantId: undefined,
    taskRunId: undefined,
    isProcessing: () => false,
    setAssistantId: (assistantId: string) => {
      conversation.assistantId = assistantId;
    },
    setTrustContext: (ctx: unknown) => {
      conversation.trustContext = ctx;
    },
    setAuthContext: (ctx: unknown) => {
      conversation.authContext = ctx;
    },
    ensureActorScopedHistory: async () => {},
    setChannelCapabilities: () => {},
    setHostCuProxy: () => {},
    addPreactivatedSkillId: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: (ctx: TurnChannelContext) => {
      turnChannelContext = ctx;
    },
    getTurnChannelContext: () => turnChannelContext,
    setTurnInterfaceContext: (ctx: TurnInterfaceContext) => {
      turnInterfaceContext = ctx;
    },
    getTurnInterfaceContext: () => turnInterfaceContext,
    getMessages: () => messages,
    usageStats: {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
    },
    persistUserMessage: mock(
      async (
        _content: string,
        _attachments: unknown[],
        _requestId?: string,
        _metadata?: Record<string, unknown>,
      ) => "persisted-user-message-id",
    ),
    setSlackRuntimeContextNotice: mock((notice: string | undefined) => {
      slackNotice = notice;
      noticeCalls.push(notice);
    }),
    runAgentLoop: mock(async (..._args: unknown[]) => {
      loopNotices.push(slackNotice);
      await loopDeferred.promise;
    }),
    updateClient: (sender: (...args: unknown[]) => void) => {
      currentSender = sender;
      clientSenders.push(sender);
    },
    getCurrentSender: () => currentSender,
    __loopDeferred: loopDeferred,
    __noticeCalls: noticeCalls,
    __loopNotices: loopNotices,
    __clientSenders: clientSenders,
  };

  return conversation;
}

describe("processMessageInBackground Slack option propagation", () => {
  beforeEach(() => {
    activeConversation = makeConversation();
    mergeConversationOptionsMock.mockClear();
  });

  test("passes Slack inbound metadata to persistence and exposes the runtime notice during the loop", async () => {
    const slackInbound = {
      channelId: "C0123CHANNEL",
      channelTs: "1700000001.111111",
      threadTs: "1700000000.000001",
      displayName: "Alice",
    };
    const notice =
      "Slack context note: this turn joined an existing thread. 2 earlier messages were backfilled.";

    const result = await processMessageInBackground(
      "conv-background-slack",
      "Reply from Slack",
      undefined,
      {
        slackInbound,
        slackRuntimeContextNotice: notice,
      },
      "slack",
      "slack",
    );

    expect(result).toEqual({ messageId: "persisted-user-message-id" });
    expect(activeConversation.persistUserMessage).toHaveBeenCalledTimes(1);
    expect(activeConversation.persistUserMessage.mock.calls[0][3]).toEqual({
      slackInbound,
    });
    expect(activeConversation.runAgentLoop).toHaveBeenCalledTimes(1);
    expect(activeConversation.__loopNotices).toEqual([notice]);

    activeConversation.__loopDeferred.resolve();
    await activeConversation.__loopDeferred.promise;
    await Promise.resolve();

    expect(activeConversation.__noticeCalls).toEqual([notice, undefined]);
  });

  test("clears the Slack runtime notice after normal message processing", async () => {
    const notice =
      "Slack context note: this turn joined an existing thread. 2 earlier messages were backfilled.";

    const processing = processMessage(
      "conv-background-slack",
      "Reply from Slack",
      undefined,
      {
        slackRuntimeContextNotice: notice,
        isInteractive: true,
      },
      "slack",
      "slack",
    );

    await waitForRunAgentLoopCall();

    expect(activeConversation.runAgentLoop).toHaveBeenCalledTimes(1);
    expect(activeConversation.__loopNotices).toEqual([notice]);

    activeConversation.__loopDeferred.resolve();
    await expect(processing).resolves.toEqual({
      messageId: "persisted-user-message-id",
    });

    expect(activeConversation.__noticeCalls).toEqual([notice, undefined]);
    expect(activeConversation.__clientSenders).toHaveLength(2);
  });

  test("leaves non-Slack background persistence metadata absent", async () => {
    await processMessageInBackground(
      "conv-background-slack",
      "Regular background wake",
      undefined,
      undefined,
      "vellum",
      "web",
    );

    expect(activeConversation.persistUserMessage).toHaveBeenCalledTimes(1);
    expect(
      activeConversation.persistUserMessage.mock.calls[0][3],
    ).toBeUndefined();
    expect(activeConversation.runAgentLoop.mock.calls[0][3]).toEqual({
      isInteractive: false,
      isUserMessage: true,
    });

    activeConversation.__loopDeferred.resolve();
  });
});
