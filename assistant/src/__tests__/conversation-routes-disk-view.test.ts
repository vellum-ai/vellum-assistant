import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import { createAssistantMessage } from "../agent/message-types.js";
import type { Conversation } from "../daemon/conversation.js";
import { persistUserMessage } from "../daemon/conversation-messaging.js";
import {
  addMessage,
  getConversation,
  provenanceFromTrustContext,
} from "../memory/conversation-crud.js";
import {
  getConversationDirPath,
  syncMessageToDisk,
} from "../memory/conversation-disk-view.js";
import {
  getConversationByKey,
  getOrCreateConversation as getOrCreateConversationMapping,
} from "../memory/conversation-key-store.js";
import { getDb, initializeDb } from "../memory/db.js";
import { AssistantEventHub } from "../runtime/assistant-event-hub.js";
import type { AuthContext } from "../runtime/auth/types.js";
import { handleSendMessage } from "../runtime/routes/conversation-routes.js";

const testDir = process.env.VELLUM_WORKSPACE_DIR!;
const conversationsDir = join(testDir, "conversations");
mkdirSync(conversationsDir, { recursive: true });

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
    secretDetection: { enabled: false },
    contextWindow: { maxInputTokens: 200000 },
    services: {
      inference: {
        mode: "your-own",
        provider: "anthropic",
        model: "claude-opus-4-6",
      },
      "image-generation": {
        mode: "your-own",
        provider: "gemini",
        model: "gemini-3.1-flash-image-preview",
      },
      "web-search": { mode: "your-own", provider: "inference-provider-native" },
    },
  }),
}));

initializeDb();

const conversationInstances = new Map<string, Conversation>();

const authContext: AuthContext = {
  subject: "svc_gateway:self",
  principalType: "svc_gateway",
  assistantId: "self",
  scopeProfile: "gateway_service_v1",
  scopes: new Set([
    "chat.read",
    "chat.write",
    "approval.read",
    "approval.write",
    "settings.read",
    "settings.write",
    "attachments.read",
    "attachments.write",
    "calls.read",
    "calls.write",
    "feature_flags.read",
    "feature_flags.write",
  ]),
  policyEpoch: 1,
};

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  db.run("DELETE FROM conversation_keys");
}

function resetConversationsDir(): void {
  rmSync(conversationsDir, { recursive: true, force: true });
  mkdirSync(conversationsDir, { recursive: true });
}

function createFakeConversation(conversationId: string): Conversation {
  const conversation = {
    conversationId,
    processing: false,
    currentRequestId: undefined as string | undefined,
    abortController: null as AbortController | null,
    trustContext: undefined as unknown,
    turnChannelContext: null as {
      userMessageChannel: string;
      assistantMessageChannel: string;
    } | null,
    turnInterfaceContext: null as {
      userMessageInterface: string;
      assistantMessageInterface: string;
    } | null,
    messages: [] as Array<unknown>,
    hostBashProxy: undefined as unknown,
    hostBrowserProxy: undefined as unknown,
    hostFileProxy: undefined as unknown,
    hostCuProxy: undefined as unknown,
    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    memoryPolicy: {
      scopeId: "default",
      includeDefaultFallback: false,
      strictSideEffects: false,
    },
    isProcessing(this: { processing: boolean }) {
      return this.processing;
    },
    setChannelCapabilities: () => {},
    setAssistantId: () => {},
    setTrustContext(this: { trustContext: unknown }, ctx: unknown) {
      this.trustContext = ctx;
    },
    setAuthContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext(
      this: {
        turnChannelContext: {
          userMessageChannel: string;
          assistantMessageChannel: string;
        } | null;
      },
      ctx: { userMessageChannel: string; assistantMessageChannel: string },
    ) {
      this.turnChannelContext = ctx;
    },
    getTurnChannelContext(this: {
      turnChannelContext: {
        userMessageChannel: string;
        assistantMessageChannel: string;
      } | null;
    }) {
      return this.turnChannelContext;
    },
    setTurnInterfaceContext(
      this: {
        turnInterfaceContext: {
          userMessageInterface: string;
          assistantMessageInterface: string;
        } | null;
      },
      ctx: {
        userMessageInterface: string;
        assistantMessageInterface: string;
      },
    ) {
      this.turnInterfaceContext = ctx;
    },
    getTurnInterfaceContext(this: {
      turnInterfaceContext: {
        userMessageInterface: string;
        assistantMessageInterface: string;
      } | null;
    }) {
      return this.turnInterfaceContext;
    },
    ensureActorScopedHistory: async () => {},
    updateClient: () => {},
    setHostBashProxy(this: { hostBashProxy: unknown }, proxy: unknown) {
      this.hostBashProxy = proxy;
    },
    setHostBrowserProxy(this: { hostBrowserProxy: unknown }, proxy: unknown) {
      this.hostBrowserProxy = proxy;
    },
    setHostFileProxy(this: { hostFileProxy: unknown }, proxy: unknown) {
      this.hostFileProxy = proxy;
    },
    setHostCuProxy(this: { hostCuProxy: unknown }, proxy: unknown) {
      this.hostCuProxy = proxy;
    },
    restoreBrowserProxyAvailability: () => {},
    addPreactivatedSkillId: () => {},
    hasAnyPendingConfirmation: () => false,
    hasPendingConfirmation: () => false,
    denyAllPendingConfirmations: () => {},
    emitConfirmationStateChanged: () => {},
    emitActivityState: () => {},
    enqueueMessage: () => ({ queued: true, requestId: crypto.randomUUID() }),
    getQueueDepth: () => 0,
    handleConfirmationResponse: () => {},
    handleSecretResponse: () => {},
    getMessages(this: { messages: Array<unknown> }) {
      return this.messages as never[];
    },
    persistUserMessage(
      this: Conversation,
      content: string,
      attachments: Array<{
        id: string;
        filename: string;
        mimeType: string;
        data: string;
        extractedText?: string;
        filePath?: string;
      }>,
      requestId?: string,
      metadata?: Record<string, unknown>,
      displayContent?: string,
    ): Promise<string> {
      return persistUserMessage(
        this as Parameters<typeof persistUserMessage>[0],
        content,
        attachments,
        requestId,
        metadata,
        displayContent,
      );
    },
    async runAgentLoop(
      this: {
        conversationId: string;
        turnChannelContext: {
          userMessageChannel: string;
          assistantMessageChannel: string;
        } | null;
        turnInterfaceContext: {
          userMessageInterface: string;
          assistantMessageInterface: string;
        } | null;
        trustContext: unknown;
        messages: Array<unknown>;
        processing: boolean;
        abortController: AbortController | null;
        currentRequestId?: string;
      },
      _content: string,
      _userMessageId: string,
      onEvent: (msg: Record<string, unknown>) => void,
    ): Promise<void> {
      const assistantText = "Synthetic assistant reply";
      const assistantMessage = createAssistantMessage(assistantText);
      const assistantMetadata = {
        ...provenanceFromTrustContext(this.trustContext as never),
        ...(this.turnChannelContext
          ? {
              userMessageChannel: this.turnChannelContext.userMessageChannel,
              assistantMessageChannel:
                this.turnChannelContext.assistantMessageChannel,
            }
          : {}),
        ...(this.turnInterfaceContext
          ? {
              userMessageInterface:
                this.turnInterfaceContext.userMessageInterface,
              assistantMessageInterface:
                this.turnInterfaceContext.assistantMessageInterface,
            }
          : {}),
      };

      const persistedAssistant = await addMessage(
        this.conversationId,
        "assistant",
        JSON.stringify(assistantMessage.content),
        assistantMetadata,
      );
      this.messages.push(assistantMessage);

      const conversationRow = getConversation(this.conversationId);
      if (conversationRow) {
        syncMessageToDisk(
          this.conversationId,
          persistedAssistant.id,
          conversationRow.createdAt,
        );
      }

      onEvent({
        type: "assistant_text_delta",
        text: assistantText,
        conversationId: this.conversationId,
      });
      onEvent({
        type: "message_complete",
        conversationId: this.conversationId,
      });

      this.processing = false;
      this.abortController = null;
      this.currentRequestId = undefined;
    },
  };

  return conversation as unknown as Conversation;
}

function getOrCreateFakeConversation(conversationId: string): Conversation {
  const existing = conversationInstances.get(conversationId);
  if (existing) return existing;
  const created = createFakeConversation(conversationId);
  conversationInstances.set(conversationId, created);
  return created;
}

async function waitFor<T>(
  getter: () => T | undefined,
  timeoutMs = 3000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = getter();
    if (value !== undefined) return value;
    await Bun.sleep(20);
  }
  throw new Error("Timed out waiting for expected disk-view output");
}

beforeEach(() => {
  resetTables();
  resetConversationsDir();
  conversationInstances.clear();
});

describe("conversationKey send path disk-view regression", () => {
  test("first send on a fresh conversationKey creates disk-view dir and writes user+assistant records", async () => {
    const conversationKey = `fresh-conv-key-${crypto.randomUUID()}`;
    const content = "Please persist this first turn.";

    const response = await handleSendMessage(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationKey,
          content,
          sourceChannel: "vellum",
          interface: "macos",
        }),
      }),
      {
        sendMessageDeps: {
          getOrCreateConversation: async (conversationId: string) =>
            getOrCreateFakeConversation(conversationId),
          assistantEventHub: new AssistantEventHub(),
          resolveAttachments: () => [],
        },
      },
      authContext,
    );

    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      accepted: boolean;
      conversationId: string;
      messageId: string;
    };
    expect(body.accepted).toBe(true);
    expect(body.conversationId).toBeDefined();
    expect(body.messageId).toBeDefined();

    // Verify the real key store mapping is reused after the first send.
    const mapping = getOrCreateConversationMapping(conversationKey);
    expect(mapping.created).toBe(false);
    expect(mapping.conversationId).toBe(body.conversationId);
    expect(getConversationByKey(conversationKey)?.conversationId).toBe(
      body.conversationId,
    );

    const conversationRow = getConversation(body.conversationId);
    expect(conversationRow).not.toBeNull();
    const conversationDir = getConversationDirPath(
      body.conversationId,
      conversationRow!.createdAt,
    );
    const metaPath = join(conversationDir, "meta.json");
    const messagesPath = join(conversationDir, "messages.jsonl");

    expect(existsSync(conversationDir)).toBe(true);
    expect(existsSync(metaPath)).toBe(true);

    const lines = await waitFor(() => {
      if (!existsSync(messagesPath)) return undefined;
      const raw = readFileSync(messagesPath, "utf-8").trim();
      if (!raw) return undefined;
      const parsed = raw
        .split("\n")
        .map((line) => JSON.parse(line) as { role: string; content?: string });
      return parsed.length >= 2 ? parsed : undefined;
    });

    expect(lines[0]?.role).toBe("user");
    expect(lines[0]?.content).toBe(content);
    expect(lines[1]?.role).toBe("assistant");
    expect(lines[1]?.content).toBe("Synthetic assistant reply");
  });
});
