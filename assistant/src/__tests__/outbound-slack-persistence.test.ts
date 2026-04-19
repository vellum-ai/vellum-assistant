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

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
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
  }),
  loadConfig: () => ({}),
}));

// `addMessage` is the only DB-touching call we need to inspect. We capture
// its arguments per test invocation so each case can assert on the metadata
// that was actually persisted.
interface AddMessageCall {
  conversationId: string;
  role: string;
  content: string;
  metadata?: Record<string, unknown>;
}
const addMessageCalls: AddMessageCall[] = [];
mock.module("../memory/conversation-crud.js", () => ({
  addMessage: (
    conversationId: string,
    role: string,
    content: string,
    metadata?: Record<string, unknown>,
  ) => {
    addMessageCalls.push({ conversationId, role, content, metadata });
    return { id: `mock-msg-${addMessageCalls.length}` };
  },
  getConversation: () => null,
  getMessageById: () => null,
  updateMessageContent: () => {},
  // The handler treats provenance as a flat spread; returning {} keeps the
  // metadata snapshot focused on the fields under test.
  provenanceFromTrustContext: () => ({}),
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

// ── Imports (after mocks) ──────────────────────────────────────────────────

import type { AgentEvent } from "../agent/loop.js";
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../daemon/conversation-agent-loop-handlers.js";
import {
  createEventHandlerState,
  handleMessageComplete,
} from "../daemon/conversation-agent-loop-handlers.js";
import type { ServerMessage } from "../daemon/message-protocol.js";
import { setThreadTs } from "../memory/slack-thread-store.js";
import { readSlackMetadata } from "../messaging/providers/slack/message-metadata.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDeps(
  conversationId: string,
  overrides: {
    assistantMessageChannel?: "slack" | "vellum" | "telegram";
    requesterChatId?: string;
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
      },
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
        assistantMessageChannel === "vellum" ? "macos" : assistantMessageChannel,
      assistantMessageInterface:
        assistantMessageChannel === "vellum" ? "macos" : assistantMessageChannel,
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
    state = createEventHandlerState();
    state.turnStartedAt = 1_700_000_000_000;
  });

  afterEach(() => {
    addMessageCalls.length = 0;
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

  test("stamps slackMeta WITHOUT threadTs for top-level Slack replies", async () => {
    const conversationId = "conv-slack-toplevel";
    const channelId = "C456NOTHREAD";
    // No setThreadTs() call — the conversation has no thread mapping, so
    // the assistant's reply targets the channel root, not a thread.

    const deps = makeDeps(conversationId, {
      assistantMessageChannel: "slack",
      requesterChatId: channelId,
    });
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

  test("does NOT stamp slackMeta on non-Slack outbound assistant messages", async () => {
    const conversationId = "conv-vellum";
    const deps = makeDeps(conversationId, {
      assistantMessageChannel: "vellum",
    });
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
