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

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

type TestConfig = {
  ui: { userTimezone?: string; detectedTimezone?: string };
  skills: Record<string, unknown>;
};

const baseConfig: TestConfig = {
  ui: {},
  skills: {
    entries: {},
    load: { extraDirs: [], watch: true, watchDebounceMs: 250 },
    install: { nodeManager: "npm" },
    allowBundled: null,
    remoteProviders: {
      skillssh: { enabled: true },
      clawhub: { enabled: true },
    },
    remotePolicy: {
      blockSuspicious: true,
      blockMalware: true,
      maxSkillsShRisk: "medium",
    },
  },
};
let currentConfig: TestConfig = structuredClone(baseConfig);

mock.module("../config/loader.js", () => ({
  getConfig: () => currentConfig,
  loadConfig: () => ({}),
}));

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
mock.module("../memory/conversation-crud.js", () => ({
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
    if (!row) return;
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
    if (row) row.content = content;
    const call = addMessageCalls.find((c) => c.id === messageId);
    if (call) call.content = content;
  },
  // The handler treats provenance as a flat spread; returning {} keeps the
  // metadata snapshot focused on the fields under test.
  provenanceFromTrustContext: () => ({}),
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

mock.module("../memory/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
  backfillMessageIdOnLogs: () => {},
}));

mock.module("../memory/memory-recall-log-store.js", () => ({
  backfillMemoryRecallLogMessageId: () => {},
}));

mock.module("../memory/conversation-disk-view.js", () => ({
  syncMessageToDisk: () => {},
}));

let nextDeliveryTs: string | null = null;
mock.module("../runtime/gateway-client.js", () => ({
  deliverChannelReply: async () => ({
    ok: true,
    ...(nextDeliveryTs ? { ts: nextDeliveryTs } : {}),
  }),
}));

mock.module("../memory/attachments-store.js", () => ({
  getAttachmentMetadataForMessage: () => [],
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

import type { AgentEvent } from "../agent/loop.js";
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../daemon/conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  handleLlmCallStarted,
  handleMessageComplete,
} from "../daemon/conversation-agent-loop-handlers.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { clearThreadTs, setThreadTs } from "../memory/slack-thread-store.js";
import { readSlackMetadata } from "../messaging/providers/slack/message-metadata.js";
import { deliverReplyViaCallback } from "../runtime/channel-reply-delivery.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDeps(
  conversationId: string,
  overrides: {
    assistantMessageChannel?: "slack" | "vellum" | "telegram";
    requesterChatId?: string;
    requesterTimezoneLabel?: string;
    clientTimezone?: string;
  } = {},
): EventHandlerDeps {
  const assistantMessageChannel = overrides.assistantMessageChannel ?? "slack";
  return {
    ctx: {
      conversationId,
      provider: { name: "anthropic" },
      traceEmitter: { emit: () => {} },
      currentTurnSurfaces: [],
      trustContext: {
        sourceChannel: assistantMessageChannel,
        trustClass: "guardian",
        requesterChatId: overrides.requesterChatId,
        requesterTimezoneLabel: overrides.requesterTimezoneLabel,
      },
      clientTimezone: overrides.clientTimezone,
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: (_msg: ServerMessage) => {},
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
    if (addMessageCalls[i].role === "assistant") return addMessageCalls[i];
  }
  throw new Error("No assistant message was persisted via addMessage");
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("outbound assistant Slack metadata persistence", () => {
  let state: EventHandlerState;

  beforeEach(() => {
    addMessageCalls.length = 0;
    persistedRows.length = 0;
    currentConfig = structuredClone(baseConfig);
    nextDeliveryTs = null;
    state = createEventHandlerState();
    state.turnStartedAt = 1_700_000_000_000;
  });

  afterEach(() => {
    addMessageCalls.length = 0;
    persistedRows.length = 0;
    nextDeliveryTs = null;
  });

  test("stamps slackMeta with threadTs when the conversation has a Slack thread mapping", async () => {
    const conversationId = "conv-slack-threaded";
    const channelId = "C123CHANNEL";
    // Seed an in-memory Slack thread mapping (mirrors the inbound path that
    // calls setThreadTs when a thread_ts arrives).
    setThreadTs(conversationId, channelId, "1234.5678");

    const deps = makeDeps(conversationId, {
      assistantMessageChannel: "slack",
      requesterChatId: channelId,
    });
    await handleLlmCallStarted(state, deps);
    await handleMessageComplete(state, deps, makeMessageCompleteEvent("hi"));

    const persisted = lastAssistantPersisted();
    const slackMetaRaw = persisted.metadata?.slackMeta;
    expect(typeof slackMetaRaw).toBe("string");

    const slackMeta = JSON.parse(slackMetaRaw as string) as Record<
      string,
      unknown
    >;
    expect(slackMeta.source).toBe("slack");
    expect(slackMeta.eventKind).toBe("message");
    expect(slackMeta.channelId).toBe(channelId);
    expect(slackMeta.threadTs).toBe("1234.5678");

    // Persistence runs BEFORE the Slack adapter posts the message, so the
    // authoritative `ts` (-> `channelTs`) is not yet known at this layer.
    // The post-send reconciliation in `deliverReplyViaCallback` fills the
    // field once the gateway returns the Slack-assigned ts (covered by
    // `channel-reply-delivery.test.ts`). Until that runs, the partial
    // metadata is intentionally rejected by `readSlackMetadata` so callers
    // that try to use it before reconciliation get a clear null.
    expect(slackMeta.channelTs).toBeUndefined();
    expect(readSlackMetadata(slackMetaRaw as string)).toBeNull();
  });

  test("stamps assistant Slack rows with effective timestamp timezone and no speaker suffix", async () => {
    currentConfig = {
      ...structuredClone(baseConfig),
      ui: { userTimezone: "America/Denver" },
    };
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
    const slackMetaRaw = persisted.metadata?.slackMeta;
    expect(typeof slackMetaRaw).toBe("string");

    const slackMeta = JSON.parse(slackMetaRaw as string) as Record<
      string,
      unknown
    >;
    expect(slackMeta.timestampTimezone).toBe("America/Denver");
    expect(slackMeta.timestampTimezoneLabel).toBe("MT");
    expect(slackMeta.speakerTimezoneLabel).toBeUndefined();
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
    const slackMeta = JSON.parse(
      persisted.metadata?.slackMeta as string,
    ) as Record<string, unknown>;
    expect(slackMeta.timestampTimezone).toBe("America/Los_Angeles");
    expect(slackMeta.timestampTimezoneLabel).toBe("PT");
  });

  test("post-send reconciliation preserves assistant Slack timezone metadata", async () => {
    currentConfig = {
      ...structuredClone(baseConfig),
      ui: { userTimezone: "America/Denver" },
    };
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
    const beforeRaw = persisted.metadata?.slackMeta;
    expect(typeof beforeRaw).toBe("string");
    expect(readSlackMetadata(beforeRaw as string)).toBeNull();

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
    const envelope = JSON.parse(row!.metadata!) as Record<string, unknown>;
    const reconciled = readSlackMetadata(envelope.slackMeta as string);
    expect(reconciled).not.toBeNull();
    expect(reconciled!.channelTs).toBe("1772678280.000200");
    expect(reconciled!.timestampTimezone).toBe("America/Denver");
    expect(reconciled!.timestampTimezoneLabel).toBe("MT");
    expect(reconciled!.speakerTimezoneLabel).toBeUndefined();
  });

  test("stamps slackMeta WITHOUT threadTs for top-level Slack replies", async () => {
    const conversationId = "conv-slack-toplevel";
    const channelId = "C456NOTHREAD";
    // No setThreadTs() call — the conversation has no thread mapping, so
    // the assistant's reply targets the channel root, not a thread.

    const deps = makeDeps(conversationId, {
      assistantMessageChannel: "slack",
      requesterChatId: channelId,
    });
    await handleLlmCallStarted(state, deps);
    await handleMessageComplete(state, deps, makeMessageCompleteEvent("hello"));

    const persisted = lastAssistantPersisted();
    const slackMetaRaw = persisted.metadata?.slackMeta;
    expect(typeof slackMetaRaw).toBe("string");

    const slackMeta = JSON.parse(slackMetaRaw as string) as Record<
      string,
      unknown
    >;
    expect(slackMeta.source).toBe("slack");
    expect(slackMeta.eventKind).toBe("message");
    expect(slackMeta.channelId).toBe(channelId);
    // threadTs is intentionally absent — top-level reply.
    expect(slackMeta.threadTs).toBeUndefined();
    // channelTs is still absent for the same persistence-vs-send reason.
    expect(slackMeta.channelTs).toBeUndefined();
  });

  test("does NOT stamp a stale threadTs after the mapping is cleared", async () => {
    const conversationId = "conv-slack-cleared";
    const channelId = "C789CLEARED";
    // Simulate an earlier threaded turn that seeded the mapping, followed
    // by a channel-root turn whose inbound path cleared it.
    setThreadTs(conversationId, channelId, "1111.2222");
    clearThreadTs(conversationId);

    const deps = makeDeps(conversationId, {
      assistantMessageChannel: "slack",
      requesterChatId: channelId,
    });
    await handleLlmCallStarted(state, deps);
    await handleMessageComplete(
      state,
      deps,
      makeMessageCompleteEvent("root reply"),
    );

    const persisted = lastAssistantPersisted();
    const slackMetaRaw = persisted.metadata?.slackMeta;
    expect(typeof slackMetaRaw).toBe("string");
    const slackMeta = JSON.parse(slackMetaRaw as string) as Record<
      string,
      unknown
    >;
    expect(slackMeta.threadTs).toBeUndefined();
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
    // Non-Slack channels must leave the existing metadata shape untouched.
    expect(persisted.metadata?.slackMeta).toBeUndefined();
  });
});
