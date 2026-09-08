/**
 * Tests that `handleMessageComplete` stamps a `slackMeta` sub-object on the
 * persisted assistant message metadata when the turn's
 * `assistantMessageChannel === "slack"`.
 *
 * Persistence happens BEFORE the Slack adapter sends the message, so Slack's
 * authoritative `ts` (-> `channelTs`) is not yet known at this layer. The
 * partial `slackMeta` written here is intentionally missing `channelTs`; the
 * post-send reconciliation step in `deliverReplyViaCallback` writes
 * `channelTs` back into the row once the gateway returns the Slack-assigned
 * ts. These tests document the persistence-side ordering — see
 * `channel-reply-delivery.test.ts` for the reconciliation behaviour.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Shared mock plumbing (must precede module-under-test imports) ──────────

// `addMessage` is the only DB-touching call we need to inspect. We capture
// its arguments per test invocation so each case can assert on the metadata
// that was actually persisted.
interface AddMessageCall {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}
const addMessageCalls: AddMessageCall[] = [];
const persistedRows: Array<{
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: number;
  metadata: string | null;
}> = [];
mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  addMessage: (
    conversationId: string,
    role: string,
    content: string,
    options?: { metadata?: Record<string, unknown> },
  ) => {
    const metadata = options?.metadata;
    const id = `mock-msg-${addMessageCalls.length + 1}`;
    addMessageCalls.push({ id, conversationId, role, content, metadata });
    persistedRows.push({
      id,
      conversationId,
      role,
      content,
      createdAt: Date.now(),
      metadata: metadata ? JSON.stringify(metadata) : null,
    });
    return { id };
  },
  getConversation: () => null,
  getMessageById: (messageId: string) =>
    persistedRows.find((row) => row.id === messageId) ?? null,
  getMessages: (conversationId: string) =>
    persistedRows.filter((row) => row.conversationId === conversationId),
  updateMessageMetadata: (
    messageId: string,
    updates: Record<string, unknown>,
  ) => {
    const row = persistedRows.find((candidate) => candidate.id === messageId);
    if (!row) {
      return;
    }
    const existing =
      row.metadata && typeof row.metadata === "string"
        ? (JSON.parse(row.metadata) as Record<string, unknown>)
        : {};
    row.metadata = JSON.stringify({ ...existing, ...updates });
  },
  updateMessageContent: (messageId: string, content: string) => {
    // Mirror updateContent into the same capture array so existing
    // `lastAssistantPersisted()` assertions continue to find the row that
    // was reserved at `llm_call_started` time.
    const row = persistedRows.find((candidate) => candidate.id === messageId);
    if (row) {
      row.content = content;
    }
    const call = addMessageCalls.find((c) => c.id === messageId);
    if (call) {
      call.content = content;
    }
  },
  markMessageContentInflight: () => {},
  finalizeMessageContent: (messageId: string, content: string) => {
    // The finalize seam writes through `finalizeMessageContent`; mirror it
    // into the same captures as `updateMessageContent`.
    const row = persistedRows.find((candidate) => candidate.id === messageId);
    if (row) {
      row.content = content;
    }
    const call = addMessageCalls.find((c) => c.id === messageId);
    if (call) {
      call.content = content;
    }
  },
  // The handler treats provenance as a flat spread; returning {} keeps the
  // metadata snapshot focused on the fields under test.
  // Mirrors the real mapping so provenance assertions observe what production
  // stamps rather than a placeholder.
  provenanceFromTrustContext: (ctx?: { trustClass?: string }) =>
    ctx ? { provenanceTrustClass: ctx.trustClass } : {},
  reserveMessage: mock(
    async (
      conversationId: string,
      role: string,
      metadata?: Record<string, unknown>,
    ) => {
      // B3: production code creates the assistant row at `llm_call_started`
      // via `reserveMessage`, stamping channel metadata at reserve time.
      // Mirror that into the addMessage capture array so existing
      // `lastAssistantPersisted()` assertions keep working.
      const id = `mock-msg-${addMessageCalls.length + 1}-reserve`;
      addMessageCalls.push({
        id,
        conversationId,
        role,
        content: "",
        metadata,
      });
      persistedRows.push({
        id,
        conversationId,
        role,
        content: "",
        createdAt: Date.now(),
        metadata: metadata ? JSON.stringify(metadata) : null,
      });
      return { id };
    },
  ),
}));

const recordedOutboundPosts: Array<Record<string, string>> = [];
mock.module("../persistence/delivery-crud.js", () => ({
  recordOutboundPost: (post: Record<string, string>) => {
    recordedOutboundPosts.push(post);
  },
}));

mock.module("../persistence/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
}));

mock.module("../plugins/defaults/memory/memory-recall-log-store.js", () => ({
  backfillMemoryRecallLogMessageId: () => {},
}));

mock.module("../persistence/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
}));

let nextDeliveryTs: string | null = null;
mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async () => ({
    ok: true,
    ...(nextDeliveryTs ? { ts: nextDeliveryTs } : {}),
  }),
}));

mock.module("../persistence/attachments-store.js", () => ({
  getAttachmentMetadataForMessage: () => [],
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import type { AgentEvent } from "../agent/loop.js";
import type { AssistantEvent } from "../api/index.js";
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../daemon/conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  handleLlmCallStarted,
  handleMessageComplete,
} from "../daemon/conversation-agent-loop-handlers.js";
import { readSlackMetadataFromMessageMetadata } from "../messaging/providers/slack/message-metadata.js";
import { deliverReplyViaCallback } from "../runtime/channel-reply-delivery.js";
import { setConfig } from "./helpers/set-config.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDeps(
  conversationId: string,
  overrides: {
    assistantMessageChannel?: "slack" | "vellum" | "telegram" | "discord";
    requesterChatId?: string;
    requesterTimezoneLabel?: string;
    clientTimezone?: string;
    sourceThreadId?: string;
    /** Turn-local trust; when set, the live slot below diverges from it. */
    currentTurnTrustContext?: Record<string, unknown>;
  } = {},
): EventHandlerDeps {
  const assistantMessageChannel = overrides.assistantMessageChannel ?? "slack";
  return {
    ctx: {
      conversationId,
      provider: { name: "anthropic" },
      currentTurnSurfaces: [],
      currentTurnTrustContext: overrides.currentTurnTrustContext,
      trustContext: {
        sourceChannel: assistantMessageChannel,
        trustClass: "guardian",
        requesterChatId: overrides.requesterChatId,
        requesterTimezoneLabel: overrides.requesterTimezoneLabel,
        sourceThreadId: overrides.sourceThreadId,
      },
      clientTimezone: overrides.clientTimezone,
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: (_msg: AssistantEvent) => {},
    reqId: "test-req-id",
    isFirstMessage: false,
    shouldGenerateTitle: false,
    rlog: new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }) as unknown as EventHandlerDeps["rlog"],
    turnChannelContext: {
      userMessageChannel: assistantMessageChannel,
      assistantMessageChannel,
    } as EventHandlerDeps["turnChannelContext"],
    turnInterfaceContext: {
      userMessageInterface:
        assistantMessageChannel === "vellum"
          ? "macos"
          : assistantMessageChannel,
      assistantMessageInterface:
        assistantMessageChannel === "vellum"
          ? "macos"
          : assistantMessageChannel,
    } as EventHandlerDeps["turnInterfaceContext"],
  } as EventHandlerDeps;
}

function makeMessageCompleteEvent(
  text: string,
): Extract<AgentEvent, { type: "message_complete" }> {
  return {
    type: "message_complete",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  };
}

/** Find the most recently persisted assistant-role message in the capture log. */
function lastAssistantPersisted(): AddMessageCall {
  for (let i = addMessageCalls.length - 1; i >= 0; i--) {
    if (addMessageCalls[i].role === "assistant") {
      return addMessageCalls[i];
    }
  }
  throw new Error("No assistant message was persisted via addMessage");
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("outbound assistant Slack metadata persistence", () => {
  let state: EventHandlerState;

  beforeEach(() => {
    addMessageCalls.length = 0;
    persistedRows.length = 0;
    setConfig("ui", {});
    nextDeliveryTs = null;
    recordedOutboundPosts.length = 0;
    state = createEventHandlerState();
    state.turnStartedAt = 1_700_000_000_000;
  });

  afterEach(() => {
    addMessageCalls.length = 0;
    persistedRows.length = 0;
    nextDeliveryTs = null;
  });

  test("stamps the neutral envelope with the turn's inbound thread id", async () => {
    const conversationId = "conv-slack-threaded";
    const channelId = "C123CHANNEL";

    // The turn arrived in a thread: its inbound thread ts is captured on the
    // trust context (`sourceThreadId`) at ingress, and the reply is stamped
    // from that turn-local value. A Slack reply row writes the same neutral
    // envelope every channel writes; Slack's own fields ride its passthrough.
    const deps = makeDeps(conversationId, {
      assistantMessageChannel: "slack",
      requesterChatId: channelId,
      sourceThreadId: "1234.5678",
    });
    await handleLlmCallStarted(state, deps);
    await handleMessageComplete(state, deps, makeMessageCompleteEvent("hi"));

    const persisted = lastAssistantPersisted();
    expect(persisted.metadata?.slackMeta).toBeUndefined();
    const providerMetaRaw = persisted.metadata?.providerMeta;
    expect(typeof providerMetaRaw).toBe("string");

    const providerMeta = JSON.parse(providerMetaRaw as string) as Record<
      string,
      unknown
    >;
    expect(providerMeta.source).toBe("slack");
    expect(providerMeta.eventKind).toBe("message");
    expect(providerMeta.conversationExternalId).toBe(channelId);
    expect(providerMeta.threadId).toBe("1234.5678");

    // Persistence runs BEFORE the Slack adapter posts the message, so the
    // authoritative ts (the envelope's `messageId`) is not yet known at this
    // layer. The post-send reconciliation in `deliverReplyViaCallback` fills
    // it once the gateway returns the Slack-assigned ts (covered by
    // `channel-reply-delivery.test.ts`). Until then the row has no Slack
    // view, so a Slack reader gets a clear null rather than a half row.
    expect(providerMeta.messageId).toBeUndefined();
    expect(
      readSlackMetadataFromMessageMetadata(JSON.stringify(persisted.metadata)),
    ).toBeNull();
  });

  test("stamps assistant Slack rows with effective timestamp timezone and no speaker suffix", async () => {
    setConfig("ui", { userTimezone: "America/Denver" });
    state.turnStartedAt = Date.parse("2026-03-05T03:38:00Z");
    const conversationId = "conv-slack-timezone";
    const channelId = "C999TIMEZONE";

    const deps = makeDeps(conversationId, {
      assistantMessageChannel: "slack",
      requesterChatId: channelId,
      requesterTimezoneLabel: "ET",
      clientTimezone: "America/Los_Angeles",
    });
    await handleLlmCallStarted(state, deps);
    await handleMessageComplete(
      state,
      deps,
      makeMessageCompleteEvent("timezone-aware reply"),
    );

    const persisted = lastAssistantPersisted();
    const providerMeta = JSON.parse(
      persisted.metadata?.providerMeta as string,
    ) as Record<string, unknown>;
    expect(providerMeta.timestampTimezone).toBe("America/Denver");
    expect(providerMeta.timestampTimezoneLabel).toBe("MT");
    expect(providerMeta.speakerTimezoneLabel).toBeUndefined();
  });

  test("falls back to the turn client timezone when no configured user timezone is set", async () => {
    const conversationId = "conv-slack-client-timezone";
    const channelId = "C999CLIENTTZ";

    const deps = makeDeps(conversationId, {
      assistantMessageChannel: "slack",
      requesterChatId: channelId,
      clientTimezone: "America/Los_Angeles",
    });
    await handleLlmCallStarted(state, deps);
    await handleMessageComplete(
      state,
      deps,
      makeMessageCompleteEvent("client timezone reply"),
    );

    const persisted = lastAssistantPersisted();
    const providerMeta = JSON.parse(
      persisted.metadata?.providerMeta as string,
    ) as Record<string, unknown>;
    expect(providerMeta.timestampTimezone).toBe("America/Los_Angeles");
    expect(providerMeta.timestampTimezoneLabel).toBe("PT");
  });

  test("post-send reconciliation gives the row its Slack view, timezone fields intact", async () => {
    setConfig("ui", { userTimezone: "America/Denver" });
    const conversationId = "conv-slack-reconcile-timezone";
    const channelId = "C999RECONCILE";

    const deps = makeDeps(conversationId, {
      assistantMessageChannel: "slack",
      requesterChatId: channelId,
      requesterTimezoneLabel: "ET",
    });
    await handleLlmCallStarted(state, deps);
    await handleMessageComplete(
      state,
      deps,
      makeMessageCompleteEvent("delivery reconciliation reply"),
    );

    const persisted = lastAssistantPersisted();
    expect(
      readSlackMetadataFromMessageMetadata(JSON.stringify(persisted.metadata)),
    ).toBeNull();

    nextDeliveryTs = "1772678280.000200";
    await deliverReplyViaCallback(
      conversationId,
      channelId,
      "http://gateway/deliver/slack",
      "assistant-1",
      { messageId: persisted.id },
    );

    const row = persistedRows.find(
      (candidate) => candidate.id === persisted.id,
    );
    expect(typeof row?.metadata).toBe("string");
    // The Slack renderers read the reconciled row through its Slack view.
    const view = readSlackMetadataFromMessageMetadata(row!.metadata!);
    expect(view).not.toBeNull();
    expect(view!.channelId).toBe(channelId);
    expect(view!.channelTs).toBe("1772678280.000200");
    expect(view!.timestampTimezone).toBe("America/Denver");
    expect(view!.timestampTimezoneLabel).toBe("MT");
    expect(view!.speakerTimezoneLabel).toBeUndefined();
    // And the post is in the outbound index, exactly as any channel's is.
    expect(recordedOutboundPosts).toContainEqual({
      sourceChannel: "slack",
      externalChatId: channelId,
      providerMessageId: "1772678280.000200",
      messageId: persisted.id,
      conversationId,
    });
  });

  test("stamps no threadId for top-level Slack replies", async () => {
    const conversationId = "conv-slack-toplevel";
    const channelId = "C456NOTHREAD";
    // The turn arrived at the channel root: no `sourceThreadId` on the trust
    // context, so the reply targets the channel root, not a thread.

    const deps = makeDeps(conversationId, {
      assistantMessageChannel: "slack",
      requesterChatId: channelId,
    });
    await handleLlmCallStarted(state, deps);
    await handleMessageComplete(state, deps, makeMessageCompleteEvent("hello"));

    const persisted = lastAssistantPersisted();
    const providerMeta = JSON.parse(
      persisted.metadata?.providerMeta as string,
    ) as Record<string, unknown>;
    expect(providerMeta.source).toBe("slack");
    expect(providerMeta.eventKind).toBe("message");
    expect(providerMeta.conversationExternalId).toBe(channelId);
    expect(providerMeta.threadId).toBeUndefined();
    expect(providerMeta.messageId).toBeUndefined();
  });

  test("envelope resolves from the turn's actor when the slot has moved", async () => {
    // Provenance class and Slack routing must come from ONE actor: the turn's.
    // A queued Slack turn runs while the guardian has since written the live
    // slot; the assistant row must carry the sender's class AND the sender's
    // channel/thread, not a mixed envelope.
    const conversationId = "conv-slack-moved-slot";
    const deps = makeDeps(conversationId, {
      assistantMessageChannel: "slack",
      // Live slot: the guardian, on a different chat, no thread.
      requesterChatId: "C-GUARDIAN",
      currentTurnTrustContext: {
        sourceChannel: "slack",
        trustClass: "trusted_contact",
        requesterChatId: "C-CONTACT",
        sourceThreadId: "1723300000.000100",
      },
    });
    await handleLlmCallStarted(state, deps);
    await handleMessageComplete(
      state,
      deps,
      makeMessageCompleteEvent("reply to the contact"),
    );

    const persisted = lastAssistantPersisted();
    expect(persisted.metadata?.provenanceTrustClass).toBe("trusted_contact");
    const providerMeta = JSON.parse(
      persisted.metadata?.providerMeta as string,
    ) as Record<string, unknown>;
    expect(providerMeta.conversationExternalId).toBe("C-CONTACT");
    expect(providerMeta.threadId).toBe("1723300000.000100");
  });

  test("ignores a non-ts sourceThreadId", async () => {
    const conversationId = "conv-slack-bad-thread";
    const channelId = "C789BAD";
    // A malformed thread id must not be stamped as a thread (isSlackTs guard).
    const deps = makeDeps(conversationId, {
      assistantMessageChannel: "slack",
      requesterChatId: channelId,
      sourceThreadId: "not-a-ts",
    });
    await handleLlmCallStarted(state, deps);
    await handleMessageComplete(
      state,
      deps,
      makeMessageCompleteEvent("root reply"),
    );

    const persisted = lastAssistantPersisted();
    const providerMeta = JSON.parse(
      persisted.metadata?.providerMeta as string,
    ) as Record<string, unknown>;
    expect(providerMeta.threadId).toBeUndefined();
  });

  test("does NOT stamp slackMeta on non-Slack outbound assistant messages", async () => {
    const conversationId = "conv-vellum";
    const deps = makeDeps(conversationId, {
      assistantMessageChannel: "vellum",
    });
    await handleLlmCallStarted(state, deps);
    await handleMessageComplete(
      state,
      deps,
      makeMessageCompleteEvent("vellum reply"),
    );

    const persisted = lastAssistantPersisted();
    expect(persisted.metadata).toBeDefined();
    // Non-Slack channels must leave the existing metadata shape untouched,
    // and a vellum turn is not a provider message, so it gets no neutral
    // envelope either.
    expect(persisted.metadata?.slackMeta).toBeUndefined();
    expect(persisted.metadata?.providerMeta).toBeUndefined();
  });

  test("stamps a partial neutral envelope on non-Slack channel replies", async () => {
    const conversationId = "conv-discord-stamp";
    const deps = makeDeps(conversationId, {
      assistantMessageChannel: "discord",
      requesterChatId: "9990001112223334445",
    });
    await handleLlmCallStarted(state, deps);
    await handleMessageComplete(
      state,
      deps,
      makeMessageCompleteEvent("discord reply"),
    );

    const persisted = lastAssistantPersisted();
    const providerMetaRaw = persisted.metadata?.providerMeta;
    expect(typeof providerMetaRaw).toBe("string");
    const providerMeta = JSON.parse(providerMetaRaw as string) as Record<
      string,
      unknown
    >;
    expect(providerMeta.source).toBe("discord");
    expect(providerMeta.conversationExternalId).toBe("9990001112223334445");
    expect(providerMeta.eventKind).toBe("message");
    // Persistence runs BEFORE the transport posts the message, so the
    // provider-assigned id is not yet known; the post-send reconciliation in
    // `deliverReplyViaCallback` fills `messageId` once the transport returns
    // it. `threadId` is never stamped: a value there asserts a thread exists.
    expect(providerMeta.messageId).toBeUndefined();
    expect(providerMeta.threadId).toBeUndefined();
    expect(persisted.metadata?.slackMeta).toBeUndefined();
  });

  test("post-send reconciliation patches messageId into the neutral envelope", async () => {
    const conversationId = "conv-discord-reconcile";
    const chatId = "9990001112223334445";
    const deps = makeDeps(conversationId, {
      assistantMessageChannel: "discord",
      requesterChatId: chatId,
    });
    await handleLlmCallStarted(state, deps);
    await handleMessageComplete(
      state,
      deps,
      makeMessageCompleteEvent("discord reconciliation reply"),
    );

    const persisted = lastAssistantPersisted();
    nextDeliveryTs = "1234567890123456789";
    await deliverReplyViaCallback(
      conversationId,
      chatId,
      "http://gateway/deliver/discord",
      "assistant-1",
      { messageId: persisted.id },
    );

    const row = persistedRows.find(
      (candidate) => candidate.id === persisted.id,
    );
    expect(typeof row?.metadata).toBe("string");
    const envelope = JSON.parse(row!.metadata!) as Record<string, unknown>;
    const reconciled = JSON.parse(envelope.providerMeta as string) as Record<
      string,
      unknown
    >;
    expect(reconciled.messageId).toBe("1234567890123456789");
    expect(reconciled.source).toBe("discord");
    expect(reconciled.conversationExternalId).toBe(chatId);

    // A later report with a NEW id is another post of the same reply (a
    // split at a tool boundary): it lands in additionalMessageIds and the
    // first id keeps naming the row.
    nextDeliveryTs = "8888888888888888888";
    await deliverReplyViaCallback(
      conversationId,
      chatId,
      "http://gateway/deliver/discord",
      "assistant-1",
      { messageId: persisted.id },
    );
    const rowAfter = persistedRows.find(
      (candidate) => candidate.id === persisted.id,
    );
    const metaAfter = JSON.parse(
      JSON.parse(rowAfter!.metadata!).providerMeta as string,
    ) as Record<string, unknown>;
    expect(metaAfter.messageId).toBe("1234567890123456789");
    expect(metaAfter.additionalMessageIds).toEqual(["8888888888888888888"]);
    // Both ids also land in the channel_outbound_posts resolution index,
    // written by the same reconciliation so envelope and index cannot drift.
    expect(recordedOutboundPosts.map((post) => post.providerMessageId)).toEqual(
      ["1234567890123456789", "8888888888888888888"],
    );
    expect(recordedOutboundPosts[0].messageId).toBe(persisted.id);

    // A redelivery reporting an already-recorded id changes nothing.
    nextDeliveryTs = "8888888888888888888";
    await deliverReplyViaCallback(
      conversationId,
      chatId,
      "http://gateway/deliver/discord",
      "assistant-1",
      { messageId: persisted.id },
    );
    const rowRedelivered = persistedRows.find(
      (candidate) => candidate.id === persisted.id,
    );
    const metaRedelivered = JSON.parse(
      JSON.parse(rowRedelivered!.metadata!).providerMeta as string,
    ) as Record<string, unknown>;
    expect(metaRedelivered.additionalMessageIds).toEqual([
      "8888888888888888888",
    ]);
  });
});
