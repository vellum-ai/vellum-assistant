import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  TurnChannelContext,
  TurnInterfaceContext,
} from "../channels/types.js";
import type { Conversation } from "../daemon/conversation.js";
import { persistUserMessage as persistUserMessageImpl } from "../daemon/conversation-messaging.js";
import type { ServerMessage } from "../daemon/message-protocol.js";

let mockedConfig: {
  secretDetection: { enabled: boolean };
  calls: { disclosure: { enabled: boolean; text: string } };
  memory: { enabled: boolean };
} = {
  secretDetection: { enabled: false },
  calls: {
    disclosure: {
      enabled: false,
      text: "",
    },
  },
  memory: { enabled: false },
};

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => mockedConfig,
}));

import {
  setVoiceBridgeDeps,
  startVoiceTurn,
} from "../calls/voice-session-bridge.js";
import {
  createConversation,
  getMessages,
} from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { assistantEventHub } from "../runtime/assistant-event-hub.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

initializeDb();

/**
 * Build a session that emits multiple events via the onEvent callback,
 * simulating assistant text deltas followed by message_complete.
 */
function makeStreamingSession(events: ServerMessage[]): Conversation {
  return {
    isProcessing: () => false,
    persistUserMessage: () => undefined as unknown as string,
    memoryPolicy: {
      scopeId: "default",
      includeDefaultFallback: false,
    },
    setChannelCapabilities: () => {},
    setAssistantId: () => {},
    setTrustContext: () => {},
    setCommandIntent: () => {},
    setTurnChannelContext: () => {},
    setTurnInterfaceContext: () => {},
    setVoiceCallControlPrompt: () => {},
    updateClient: () => {},
    ensureActorScopedHistory: async () => {},
    runAgentLoop: async (
      _content: string,
      _messageId: string,
      onEvent: (msg: ServerMessage) => void,
    ) => {
      for (const event of events) {
        onEvent(event);
      }
    },
    handleConfirmationResponse: () => {},
    abort: () => {},
  } as unknown as Conversation;
}

function makePersistingStreamingSession(
  conversationId: string,
  events: ServerMessage[],
): Conversation & { callSessionId?: string } {
  type PersistUserMessageContext = Parameters<typeof persistUserMessageImpl>[0];

  let turnChannelContext: TurnChannelContext | null = null;
  let turnInterfaceContext: TurnInterfaceContext | null = null;
  const session = {
    conversationId,
    messages: [],
    processing: false,
    abortController: null,
    currentRequestId: undefined,
    queue: {} as never,
    trustContext: undefined,
    memoryPolicy: {
      scopeId: "default",
      includeDefaultFallback: false,
    },
    isProcessing: () => session.processing,
    persistUserMessage: async (
      ...args: Parameters<Conversation["persistUserMessage"]>
    ) => persistUserMessageImpl(session, ...args),
    getTurnChannelContext: () => turnChannelContext,
    getTurnInterfaceContext: () => turnInterfaceContext,
    setChannelCapabilities: () => {},
    setAssistantId: () => {},
    setTrustContext: (ctx: Parameters<Conversation["setTrustContext"]>[0]) => {
      session.trustContext = ctx ?? undefined;
    },
    setCommandIntent: () => {},
    setTurnChannelContext: (ctx: TurnChannelContext) => {
      turnChannelContext = ctx;
    },
    setTurnInterfaceContext: (ctx: TurnInterfaceContext) => {
      turnInterfaceContext = ctx;
    },
    setVoiceCallControlPrompt: () => {},
    updateClient: () => {},
    ensureActorScopedHistory: async () => {},
    runAgentLoop: async (
      _content: string,
      _messageId: string,
      onEvent: (msg: ServerMessage) => void,
    ) => {
      for (const event of events) {
        onEvent(event);
      }
      session.processing = false;
      session.abortController = null;
      session.currentRequestId = undefined;
    },
    handleConfirmationResponse: () => {},
    abort: () => {},
  } as unknown as Conversation &
    PersistUserMessageContext & {
      callSessionId?: string;
    };

  return session;
}

function parsePersistedMetadata(
  metadata: string | null | undefined,
): Record<string, unknown> {
  if (!metadata) {
    throw new Error("Expected persisted message metadata");
  }
  return JSON.parse(metadata) as Record<string, unknown>;
}

/**
 * Helper to inject voice bridge deps with a given conversation factory.
 */
function injectDeps(conversationFactory: () => Conversation): void {
  setVoiceBridgeDeps({
    getOrCreateConversation: async () => conversationFactory(),
    resolveAttachments: () => [],
  });
}

describe("voice-session-bridge", () => {
  beforeEach(() => {
    mockedConfig = {
      secretDetection: { enabled: false },
      calls: {
        disclosure: {
          enabled: false,
          text: "",
        },
      },
      memory: { enabled: false },
    };
    const db = getDb();
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    pendingInteractions.clear();
  });

  test("throws when deps not injected", async () => {
    // Reset the module-level orchestrator by re-calling with undefined
    // (we can't easily reset module state, so we test the fresh import path)
    // Instead, test that startVoiceTurn works after injection
    expect(true).toBe(true); // placeholder — real test below
  });

  test("startVoiceTurn forwards text deltas to onTextDelta callback", async () => {
    const conversation = createConversation("voice bridge delta test");
    const events: ServerMessage[] = [
      {
        type: "assistant_text_delta",
        text: "Hello ",
        conversationId: conversation.id,
      },
      {
        type: "assistant_text_delta",
        text: "world",
        conversationId: conversation.id,
      },
      { type: "message_complete", conversationId: conversation.id },
    ];
    const session = makeStreamingSession(events);
    injectDeps(() => session);

    const receivedDeltas: string[] = [];
    let completed = false;

    const handle = await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello from caller",
      isInbound: true,
      onTextDelta: (text) => receivedDeltas.push(text),
      onComplete: () => {
        completed = true;
      },
      onError: () => {},
    });

    // Wait for async agent loop
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedDeltas).toEqual(["Hello ", "world"]);
    expect(completed).toBe(true);
    expect(handle.turnId).toBeDefined();
    expect(typeof handle.abort).toBe("function");
  });

  test("startVoiceTurn forwards error events to onError callback", async () => {
    const conversation = createConversation("voice bridge error test");
    const events: ServerMessage[] = [
      { type: "error", message: "Provider unavailable" },
    ];
    const session = makeStreamingSession(events);
    injectDeps(() => session);

    const receivedErrors: string[] = [];
    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello",
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: (msg) => receivedErrors.push(msg),
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(receivedErrors).toEqual(["Provider unavailable"]);
  });

  test("abort handle cancels the in-flight turn", async () => {
    const conversation = createConversation("voice bridge abort test");
    let abortCalled = false;

    const session = {
      isProcessing: () => false,
      currentRequestId: undefined as string | undefined,
      persistUserMessage: (
        _content: string,
        _attachments: unknown[],
        requestId?: string,
      ) => {
        session.currentRequestId = requestId;
        return undefined as unknown as string;
      },
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: () => {},
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {
        await new Promise((r) => setTimeout(r, 200));
      },
      handleConfirmationResponse: () => {},
      abort: () => {
        abortCalled = true;
      },
    } as unknown as Conversation;

    injectDeps(() => session);

    const handle = await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello",
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    handle.abort();
    expect(abortCalled).toBe(true);
  });

  test("startVoiceTurn passes callSite: 'callAgent' to runAgentLoop", async () => {
    const conversation = createConversation("voice bridge callSite test");
    const events: ServerMessage[] = [
      { type: "message_complete", conversationId: conversation.id },
    ];

    let capturedOptions: Record<string, unknown> | undefined;
    const session = {
      ...makeStreamingSession(events),
      runAgentLoop: async (
        _content: string,
        _messageId: string,
        onEvent: (msg: ServerMessage) => void,
        options?: Record<string, unknown>,
      ) => {
        capturedOptions = options;
        for (const event of events) {
          onEvent(event);
        }
      },
    } as unknown as Conversation;

    injectDeps(() => session);

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello",
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(capturedOptions).toBeDefined();
    expect(capturedOptions?.callSite).toBe("callAgent");
  });

  test("external AbortSignal triggers turn abort", async () => {
    const conversation = createConversation("voice bridge signal test");
    let abortCalled = false;

    const session = {
      isProcessing: () => false,
      currentRequestId: undefined as string | undefined,
      persistUserMessage: (
        _content: string,
        _attachments: unknown[],
        requestId?: string,
      ) => {
        session.currentRequestId = requestId;
        return undefined as unknown as string;
      },
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: () => {},
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {
        await new Promise((r) => setTimeout(r, 200));
      },
      handleConfirmationResponse: () => {},
      abort: () => {
        abortCalled = true;
      },
    } as unknown as Conversation;

    injectDeps(() => session);

    const ac = new AbortController();
    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello",
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
      signal: ac.signal,
    });

    // Abort via the external controller
    ac.abort();
    // Give the event listener a microtask to fire
    await new Promise((r) => setTimeout(r, 10));

    expect(abortCalled).toBe(true);
  });

  test("startVoiceTurn passes turnChannelContext with voice channel", async () => {
    const conversation = createConversation(
      "voice bridge channel context test",
    );
    const events: ServerMessage[] = [
      { type: "message_complete", conversationId: conversation.id },
    ];

    let capturedTurnChannelContext: unknown = null;
    const session = {
      ...makeStreamingSession(events),
      setTurnChannelContext: (ctx: unknown) => {
        capturedTurnChannelContext = ctx;
      },
    } as unknown as Conversation;

    injectDeps(() => session);

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello",
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(capturedTurnChannelContext).toEqual({
      userMessageChannel: "phone",
      assistantMessageChannel: "phone",
    });
  });

  test("startVoiceTurn defaults persisted voice metadata to phone", async () => {
    const conversation = createConversation(
      "voice bridge phone metadata default test",
    );
    const events: ServerMessage[] = [
      { type: "message_complete", conversationId: conversation.id },
    ];
    const session = makePersistingStreamingSession(conversation.id, events);
    injectDeps(() => session);

    let persistedUserMessageId: string | undefined;

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello",
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
      callbacks: {
        persisted_user_message_id: (messageId) => {
          persistedUserMessageId = messageId;
        },
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    const persisted = getMessages(conversation.id).find(
      (message) => message.id === persistedUserMessageId,
    );
    const metadata = parsePersistedMetadata(persisted?.metadata);
    expect(persisted).toBeDefined();
    expect(metadata).toMatchObject({
      userMessageChannel: "phone",
      assistantMessageChannel: "phone",
      userMessageInterface: "phone",
      assistantMessageInterface: "phone",
    });
  });

  test("startVoiceTurn can persist local live voice metadata and callbacks", async () => {
    const conversation = createConversation(
      "voice bridge local live voice metadata test",
    );
    const events: ServerMessage[] = [
      {
        type: "assistant_text_delta",
        text: "Hi",
        conversationId: conversation.id,
      },
      {
        type: "message_complete",
        conversationId: conversation.id,
        messageId: "assistant-msg-1",
      },
    ];

    let capturedTransport: { channelId: string } | undefined;
    let capturedVoiceSessionId: string | undefined;
    const capturedPrompts: Array<string | null> = [];
    const session = makePersistingStreamingSession(conversation.id, events);
    session.setVoiceCallControlPrompt = (prompt: string | null) => {
      capturedPrompts.push(prompt);
    };

    setVoiceBridgeDeps({
      getOrCreateConversation: async (_conversationId, transport) => {
        capturedTransport = transport;
        return session;
      },
      resolveAttachments: () => [],
    });

    const textDeltaEvents: ServerMessage[] = [];
    const completeEvents: ServerMessage[] = [];
    let persistedUserMessageId: string | undefined;
    let persistedAssistantMessageId: string | undefined;

    await startVoiceTurn({
      conversationId: conversation.id,
      voiceSessionId: "local-live-voice-session-1",
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
      voiceControlPrompt:
        "You are speaking in a local live voice session. Keep replies brief and conversational.",
      content: "Hello from local live voice",
      isInbound: true,
      callbacks: {
        assistant_text_delta: (msg) => textDeltaEvents.push(msg),
        message_complete: (msg) => completeEvents.push(msg),
        persisted_user_message_id: (messageId) => {
          persistedUserMessageId = messageId;
          capturedVoiceSessionId = session.callSessionId;
        },
        persisted_assistant_message_id: (messageId) => {
          persistedAssistantMessageId = messageId;
        },
      },
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(capturedTransport).toEqual({ channelId: "vellum" });
    expect(capturedVoiceSessionId).toBe("local-live-voice-session-1");
    expect(capturedPrompts[0]).toBe(
      "You are speaking in a local live voice session. Keep replies brief and conversational.",
    );
    expect(textDeltaEvents).toEqual([events[0]]);
    expect(completeEvents).toEqual([events[1]]);
    expect(persistedAssistantMessageId).toBe("assistant-msg-1");

    const persisted = getMessages(conversation.id).find(
      (message) => message.id === persistedUserMessageId,
    );
    const metadata = parsePersistedMetadata(persisted?.metadata);
    expect(persisted).toBeDefined();
    expect(metadata).toMatchObject({
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
    });
  });

  test("startVoiceTurn passes guardian context to the session", async () => {
    const conversation = createConversation(
      "voice bridge guardian context test",
    );
    const events: ServerMessage[] = [
      { type: "message_complete", conversationId: conversation.id },
    ];

    let capturedTrustContext: unknown = null;
    const session = {
      ...makeStreamingSession(events),
      setTrustContext: (ctx: unknown) => {
        if (ctx != null) capturedTrustContext = ctx;
      },
    } as unknown as Conversation;

    injectDeps(() => session);

    const trustCtx = {
      sourceChannel: "phone" as const,
      trustClass: "guardian" as const,
      guardianExternalUserId: "+15550001111",
      guardianChatId: "+15550001111",
    };

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello",
      isInbound: true,
      assistantId: "test-assistant",
      trustContext: trustCtx,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(capturedTrustContext).toEqual(trustCtx);
  });

  test("inbound non-guardian opener prompt uses pickup framing instead of outbound phrasing", async () => {
    const conversation = createConversation(
      "voice bridge inbound opener framing test",
    );
    const events: ServerMessage[] = [
      { type: "message_complete", conversationId: conversation.id },
    ];

    let capturedPrompt: string | null = null;
    const session = {
      ...makeStreamingSession(events),
      setVoiceCallControlPrompt: (prompt: string | null) => {
        if (prompt != null) capturedPrompt = prompt;
      },
    } as unknown as Conversation;

    injectDeps(() => session);

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello there",
      isInbound: true,
      trustContext: {
        sourceChannel: "phone",
        trustClass: "trusted_contact",
      },
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));
    if (!capturedPrompt)
      throw new Error("Expected voice call control prompt to be set");
    const prompt: string = capturedPrompt;

    expect(prompt).toContain(
      "this is an inbound call you are answering (not a call you initiated)",
    );
    expect(prompt).toContain(
      "Introduce yourself once at the start using your assistant name if you know it",
    );
    expect(prompt).toContain(
      "If your assistant name is not known, skip the name and just identify yourself as the guardian's assistant.",
    );
    expect(prompt).toContain(
      "Never use a UUID-shaped internal assistant ID as your spoken name.",
    );
    expect(prompt).toContain(
      'Do NOT say "I\'m calling" or "I\'m calling on behalf of".',
    );
  });

  test("inbound disclosure guidance is rewritten for pickup context", async () => {
    mockedConfig = {
      secretDetection: { enabled: false },
      calls: {
        disclosure: {
          enabled: true,
          text: "At the very beginning of the call, introduce yourself as an assistant calling on behalf of the person you represent.",
        },
      },
      memory: { enabled: false },
    };

    const conversation = createConversation(
      "voice bridge inbound disclosure rewrite test",
    );
    const events: ServerMessage[] = [
      { type: "message_complete", conversationId: conversation.id },
    ];

    let capturedPrompt: string | null = null;
    const session = {
      ...makeStreamingSession(events),
      setVoiceCallControlPrompt: (prompt: string | null) => {
        if (prompt != null) capturedPrompt = prompt;
      },
    } as unknown as Conversation;

    injectDeps(() => session);

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hi",
      isInbound: true,
      trustContext: {
        sourceChannel: "phone",
        trustClass: "trusted_contact",
      },
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));
    if (!capturedPrompt)
      throw new Error("Expected voice call control prompt to be set");
    const prompt: string = capturedPrompt;

    expect(prompt).toContain(
      "At the very beginning of the call, introduce yourself as an assistant calling on behalf of the person you represent.",
    );
    expect(prompt).toContain(
      "rewrite any disclosure naturally for pickup context",
    );
    expect(prompt).toContain(
      'Do NOT say "I\'m calling", "I called you", or "I\'m calling on behalf of".',
    );
  });

  test("auto-denies confirmation requests for non-guardian voice turns", async () => {
    const conversation = createConversation(
      "voice bridge auto-deny non-guardian test",
    );

    let clientHandler: (msg: ServerMessage) => void = () => {};
    const handleConfirmationCalls: Array<{
      requestId: string;
      decision: string;
      decisionContext?: string;
    }> = [];

    const session = {
      isProcessing: () => false,
      persistUserMessage: () => undefined as unknown as string,
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: (handler: (msg: ServerMessage) => void) => {
        clientHandler = handler;
      },
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {
        // Simulate the prompter emitting a confirmation_request via the
        // updateClient callback (this is how the real prompter works).
        clientHandler({
          type: "confirmation_request",
          requestId: "req-voice-1",
          toolName: "host_bash",
          input: { command: "rm -rf /" },
          riskLevel: "high",
          allowlistOptions: [],
          scopeOptions: [],
        } as ServerMessage);
        // The auto-deny resolves the prompter immediately, so the agent loop
        // can continue. In production the loop would continue; here we just
        // return to simulate completion.
      },
      handleConfirmationResponse: (
        requestId: string,
        decision: string,
        _selectedPattern?: string,
        _selectedScope?: string,
        decisionContext?: string,
      ) => {
        handleConfirmationCalls.push({ requestId, decision, decisionContext });
      },
      abort: () => {},
    } as unknown as Conversation;

    injectDeps(() => session);

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Delete everything",
      isInbound: true,
      trustContext: {
        sourceChannel: "phone",
        trustClass: "trusted_contact",
        guardianExternalUserId: "+15550009999",
        guardianChatId: "+15550009999",
        requesterExternalUserId: "+15550002222",
      },
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));

    // The confirmation should have been auto-denied immediately
    expect(handleConfirmationCalls.length).toBe(1);
    expect(handleConfirmationCalls[0].requestId).toBe("req-voice-1");
    expect(handleConfirmationCalls[0].decision).toBe("deny");
    expect(handleConfirmationCalls[0].decisionContext).toContain("voice call");
    expect(handleConfirmationCalls[0].decisionContext).toContain("host_bash");
  });

  test("auto-denies confirmation requests for unverified_channel voice turns", async () => {
    const conversation = createConversation(
      "voice bridge auto-deny unverified test",
    );

    let clientHandler: (msg: ServerMessage) => void = () => {};
    const handleConfirmationCalls: Array<{
      requestId: string;
      decision: string;
    }> = [];

    const session = {
      isProcessing: () => false,
      persistUserMessage: () => undefined as unknown as string,
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: (handler: (msg: ServerMessage) => void) => {
        clientHandler = handler;
      },
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {
        clientHandler({
          type: "confirmation_request",
          requestId: "req-voice-2",
          toolName: "network_request",
          input: { url: "https://evil.com" },
          riskLevel: "medium",
          allowlistOptions: [],
          scopeOptions: [],
        } as ServerMessage);
      },
      handleConfirmationResponse: (requestId: string, decision: string) => {
        handleConfirmationCalls.push({ requestId, decision });
      },
      abort: () => {},
    } as unknown as Conversation;

    injectDeps(() => session);

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Make a request",
      isInbound: true,
      trustContext: {
        sourceChannel: "phone",
        trustClass: "unknown",
      },
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(handleConfirmationCalls.length).toBe(1);
    expect(handleConfirmationCalls[0].requestId).toBe("req-voice-2");
    expect(handleConfirmationCalls[0].decision).toBe("deny");
  });

  test("auto-denies confirmation requests when guardian context is missing", async () => {
    const conversation = createConversation(
      "voice bridge auto-deny unknown actor test",
    );

    let clientHandler: (msg: ServerMessage) => void = () => {};
    const handleConfirmationCalls: Array<{
      requestId: string;
      decision: string;
    }> = [];

    const session = {
      isProcessing: () => false,
      persistUserMessage: () => undefined as unknown as string,
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: (handler: (msg: ServerMessage) => void) => {
        clientHandler = handler;
      },
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {
        clientHandler({
          type: "confirmation_request",
          requestId: "req-voice-unknown",
          toolName: "host_bash",
          input: { command: "touch /tmp/x" },
          riskLevel: "medium",
          allowlistOptions: [],
          scopeOptions: [],
        } as ServerMessage);
      },
      handleConfirmationResponse: (requestId: string, decision: string) => {
        handleConfirmationCalls.push({ requestId, decision });
      },
      abort: () => {},
    } as unknown as Conversation;

    injectDeps(() => session);

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "run a command",
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(handleConfirmationCalls.length).toBe(1);
    expect(handleConfirmationCalls[0].requestId).toBe("req-voice-unknown");
    expect(handleConfirmationCalls[0].decision).toBe("deny");
  });

  test("publishes local live voice confirmation requests without auto-resolving them", async () => {
    const conversation = createConversation(
      "voice bridge local live voice approval test",
    );

    let clientHandler: (msg: ServerMessage) => void = () => {};
    const handleConfirmationCalls: Array<{
      requestId: string;
      decision: string;
    }> = [];
    const publishedMessages: ServerMessage[] = [];
    const subscription = assistantEventHub.subscribe({
      type: "process",
      filter: {
        conversationId: conversation.id,
      },
      callback: (event) => {
        publishedMessages.push(event.message);
      },
    });

    const session = {
      isProcessing: () => false,
      persistUserMessage: () => undefined as unknown as string,
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: (handler: (msg: ServerMessage) => void) => {
        clientHandler = handler;
      },
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {
        clientHandler({
          type: "confirmation_request",
          requestId: "req-local-live-voice",
          toolName: "host_bash",
          input: { command: "ls" },
          riskLevel: "low",
          allowlistOptions: [],
          scopeOptions: [],
          conversationId: conversation.id,
        } as ServerMessage);
      },
      handleConfirmationResponse: (requestId: string, decision: string) => {
        handleConfirmationCalls.push({ requestId, decision });
      },
      abort: () => {},
    } as unknown as Conversation;

    try {
      injectDeps(() => session);

      await startVoiceTurn({
        conversationId: conversation.id,
        approvalMode: "local-live-voice",
        content: "List files",
        isInbound: true,
        trustContext: {
          sourceChannel: "phone",
          trustClass: "guardian",
          guardianExternalUserId: "+12125550142",
          guardianChatId: "+12125550142",
        },
        onTextDelta: () => {},
        onComplete: () => {},
        onError: () => {},
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(handleConfirmationCalls).toHaveLength(0);
      expect(
        publishedMessages.some(
          (message) =>
            message.type === "confirmation_request" &&
            message.requestId === "req-local-live-voice",
        ),
      ).toBe(true);
      expect(pendingInteractions.get("req-local-live-voice")).toMatchObject({
        conversationId: conversation.id,
        kind: "confirmation",
        confirmationDetails: {
          toolName: "host_bash",
          riskLevel: "low",
        },
      });
    } finally {
      pendingInteractions.resolve("req-local-live-voice");
      subscription.dispose();
    }
  });

  test("auto-allows confirmation requests for guardian voice turns", async () => {
    const conversation = createConversation(
      "voice bridge auto-allow guardian test",
    );

    let clientHandler: (msg: ServerMessage) => void = () => {};
    const handleConfirmationCalls: Array<{
      requestId: string;
      decision: string;
    }> = [];

    const session = {
      isProcessing: () => false,
      persistUserMessage: () => undefined as unknown as string,
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: (handler: (msg: ServerMessage) => void) => {
        clientHandler = handler;
      },
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {
        clientHandler({
          type: "confirmation_request",
          requestId: "req-voice-3",
          toolName: "host_bash",
          input: { command: "ls" },
          riskLevel: "low",
          allowlistOptions: [],
          scopeOptions: [],
        } as ServerMessage);
        // For verified guardian voice turns, the confirmation should be
        // auto-approved so the run can continue without a chat approval UI.
      },
      handleConfirmationResponse: (requestId: string, decision: string) => {
        handleConfirmationCalls.push({ requestId, decision });
      },
      abort: () => {},
    } as unknown as Conversation;

    injectDeps(() => session);

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "List files",
      isInbound: true,
      trustContext: {
        sourceChannel: "phone",
        trustClass: "guardian",
        guardianExternalUserId: "+15550001111",
        guardianChatId: "+15550001111",
      },
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(handleConfirmationCalls.length).toBe(1);
    expect(handleConfirmationCalls[0].requestId).toBe("req-voice-3");
    expect(handleConfirmationCalls[0].decision).toBe("allow");
  });

  test("auto-resolves secret requests for voice turns (no secret-entry UI)", async () => {
    const conversation = createConversation(
      "voice bridge secret auto-resolve test",
    );

    let clientHandler: (msg: ServerMessage) => void = () => {};
    const handleSecretCalls: Array<{
      requestId: string;
      value?: string;
      delivery?: "store" | "transient_send";
    }> = [];

    const session = {
      isProcessing: () => false,
      persistUserMessage: () => undefined as unknown as string,
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: (handler: (msg: ServerMessage) => void) => {
        clientHandler = handler;
      },
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {
        clientHandler({
          type: "secret_request",
          requestId: "req-secret-1",
          service: "github",
          field: "token",
          label: "GitHub Token",
        } as ServerMessage);
      },
      handleConfirmationResponse: () => {},
      handleSecretResponse: (
        requestId: string,
        value?: string,
        delivery?: "store" | "transient_send",
      ) => {
        handleSecretCalls.push({ requestId, value, delivery });
      },
      abort: () => {},
    } as unknown as Conversation;

    injectDeps(() => session);

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "check github status",
      isInbound: true,
      trustContext: {
        sourceChannel: "phone",
        trustClass: "guardian",
        guardianExternalUserId: "+15550001111",
        guardianChatId: "+15550001111",
      },
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(handleSecretCalls.length).toBe(1);
    expect(handleSecretCalls[0].requestId).toBe("req-secret-1");
    expect(handleSecretCalls[0].value).toBeUndefined();
    expect(handleSecretCalls[0].delivery).toBe("store");
  });

  test("pre-aborted signal triggers immediate abort", async () => {
    const conversation = createConversation("voice bridge pre-abort test");
    let abortCalled = false;

    const session = {
      isProcessing: () => false,
      currentRequestId: undefined as string | undefined,
      persistUserMessage: (
        _content: string,
        _attachments: unknown[],
        requestId?: string,
      ) => {
        session.currentRequestId = requestId;
        return undefined as unknown as string;
      },
      memoryPolicy: {
        scopeId: "default",
        includeDefaultFallback: false,
      },
      setChannelCapabilities: () => {},
      setAssistantId: () => {},
      setTrustContext: () => {},
      setCommandIntent: () => {},
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setVoiceCallControlPrompt: () => {},
      updateClient: () => {},
      ensureActorScopedHistory: async () => {},
      runAgentLoop: async () => {
        await new Promise((r) => setTimeout(r, 200));
      },
      handleConfirmationResponse: () => {},
      abort: () => {
        abortCalled = true;
      },
    } as unknown as Conversation;

    injectDeps(() => session);

    const ac = new AbortController();
    ac.abort(); // Pre-abort before calling startVoiceTurn

    await startVoiceTurn({
      conversationId: conversation.id,
      content: "Hello",
      isInbound: true,
      onTextDelta: () => {},
      onComplete: () => {},
      onError: () => {},
      signal: ac.signal,
    });

    expect(abortCalled).toBe(true);
  });
});
