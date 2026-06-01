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
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../memory/conversation-disk-view.js", () => ({
  updateMetaFile: () => {},
}));

const broadcastMessages: unknown[] = [];

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: unknown) => {
    broadcastMessages.push(msg);
  },
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
    (options: {
      content: string;
      attachments?: unknown[];
      requestId?: string;
      metadata?: Record<string, unknown>;
      displayContent?: string;
      clientMessageId?: string;
    }) => Promise<{ id: string; deduplicated: boolean }>
  >
>;
type RunAgentLoopMock = ReturnType<
  typeof mock<(...args: unknown[]) => Promise<void>>
>;
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
  setHostAppControlProxy: () => void;
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
  runAgentLoop: RunAgentLoopMock;
  updateClient: (sender: (...args: unknown[]) => void) => void;
  getCurrentSender: () => ((...args: unknown[]) => void) | undefined;
  __loopDeferred: Deferred<void>;
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
import { conversationMessagesSyncTag } from "../daemon/message-types/sync.js";
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
  let currentSender: ((...args: unknown[]) => void) | undefined;
  const loopDeferred = createDeferred<void>();
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
    setHostAppControlProxy: () => {},
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
      async (_options: {
        content: string;
        attachments?: unknown[];
        requestId?: string;
        metadata?: Record<string, unknown>;
        displayContent?: string;
        clientMessageId?: string;
      }) => ({ id: "persisted-user-message-id", deduplicated: false }),
    ),
    runAgentLoop: mock(async (..._args: unknown[]) => {
      await loopDeferred.promise;
    }),
    updateClient: (sender: (...args: unknown[]) => void) => {
      currentSender = sender;
      clientSenders.push(sender);
    },
    getCurrentSender: () => currentSender,
    __loopDeferred: loopDeferred,
    __clientSenders: clientSenders,
  };

  return conversation;
}

describe("processMessageInBackground Slack option propagation", () => {
  beforeEach(() => {
    activeConversation = makeConversation();
    mergeConversationOptionsMock.mockClear();
    broadcastMessages.length = 0;
  });

  test("passes Slack inbound metadata to persistence during background processing", async () => {
    const slackInbound = {
      channelId: "C0123CHANNEL",
      channelTs: "1700000001.111111",
      threadTs: "1700000000.000001",
      displayName: "Alice",
    };

    const result = await processMessageInBackground(
      "conv-background-slack",
      "Reply from Slack",
      {
        slackInbound,
        sourceChannel: "slack",
        sourceInterface: "slack",
      },
    );

    expect(result).toEqual({ messageId: "persisted-user-message-id" });
    expect(activeConversation.persistUserMessage).toHaveBeenCalledTimes(1);
    expect(
      activeConversation.persistUserMessage.mock.calls[0][0].metadata,
    ).toEqual({ slackInbound });
    expect(activeConversation.runAgentLoop).toHaveBeenCalledTimes(1);

    activeConversation.__loopDeferred.resolve();
    await activeConversation.__loopDeferred.promise;
    await Promise.resolve();
  });

  test("observes live agent events without replacing the broadcast emitter", async () => {
    const observedMessages: unknown[] = [];

    const processing = processMessage(
      "conv-background-slack",
      "Reply from Slack",
      {
        onEvent: (msg) => {
          observedMessages.push(msg);
        },
        sourceChannel: "slack",
        sourceInterface: "slack",
      },
    );

    await waitForRunAgentLoopCall();

    const loopOptions = activeConversation.runAgentLoop.mock.calls[0][2] as
      | { onEvent?: (msg: unknown) => void }
      | undefined;
    const loopOnEvent = loopOptions?.onEvent;
    const delta = {
      type: "assistant_text_delta",
      text: "Working on it.",
      conversationId: "conv-background-slack",
    };
    loopOnEvent?.(delta);

    expect(broadcastMessages).toEqual([
      {
        type: "sync_changed",
        tags: [conversationMessagesSyncTag("conv-background-slack")],
      },
      delta,
    ]);
    expect(observedMessages).toEqual([delta]);

    activeConversation.__loopDeferred.resolve();
    await expect(processing).resolves.toEqual({
      messageId: "persisted-user-message-id",
    });
  });

  test("leaves non-Slack background persistence metadata absent", async () => {
    await processMessageInBackground(
      "conv-background-slack",
      "Regular background wake",
      {
        sourceChannel: "vellum",
        sourceInterface: "web",
      },
    );

    expect(activeConversation.persistUserMessage).toHaveBeenCalledTimes(1);
    expect(
      activeConversation.persistUserMessage.mock.calls[0][0].metadata,
    ).toBeUndefined();
    expect(activeConversation.runAgentLoop.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        isInteractive: false,
        isUserMessage: true,
      }),
    );

    activeConversation.__loopDeferred.resolve();
  });
});
