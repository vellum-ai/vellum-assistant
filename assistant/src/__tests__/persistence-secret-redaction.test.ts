/**
 * Verifies that known-pattern secrets are redacted before being written to
 * durable conversation storage while the live model history (pendingToolResults,
 * raw message content) is left untouched.
 *
 * Touch points under test:
 *   - Tool result content blocks persisted by handleMessageComplete
 *   - Assistant message text blocks persisted by handleMessageComplete
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

// ── Helpers ────────────────────────────────────────────────────────────────

const CONV = "conv-redact-test";

function makeDeps(): EventHandlerDeps {
  return {
    ctx: {
      conversationId: CONV,
      provider: { name: "anthropic" },
      traceEmitter: { emit: () => {} },
      currentTurnSurfaces: [],
      trustContext: {
        sourceChannel: "vellum",
        trustClass: "guardian",
      },
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: () => {},
    reqId: "test-req",
    isFirstMessage: false,
    shouldGenerateTitle: false,
    rlog: new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }) as unknown as EventHandlerDeps["rlog"],
    turnChannelContext: {
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
    } as EventHandlerDeps["turnChannelContext"],
    turnInterfaceContext: {
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
    } as EventHandlerDeps["turnInterfaceContext"],
  } as EventHandlerDeps;
}

function makeMessageCompleteEvent(
  text: string,
): Extract<AgentEvent, { type: "message_complete" }> {
  return {
    type: "message_complete",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function lastPersisted(role: "assistant" | "user"): AddMessageCall {
  for (let i = addMessageCalls.length - 1; i >= 0; i--) {
    if (addMessageCalls[i].role === role) return addMessageCalls[i];
  }
  throw new Error(`No ${role} message was persisted`);
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("persistence-layer secret redaction", () => {
  let state: EventHandlerState;

  beforeEach(() => {
    addMessageCalls.length = 0;
    state = createEventHandlerState();
    state.turnStartedAt = 1_700_000_000_000;
  });

  afterEach(() => {
    addMessageCalls.length = 0;
  });

  // ── Tool result content ──────────────────────────────────────────────────

  test("redacts Anthropic API key in tool result content before persistence", async () => {
    // Pattern requires 80+ chars after "sk-ant-"
    const secret =
      "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" +
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    state.pendingToolResults.set("tool-use-1", {
      content: `Here is the key: ${secret}`,
      isError: false,
    });

    await handleMessageComplete(state, makeDeps(), makeMessageCompleteEvent("done"));

    const persisted = lastPersisted("user");
    const blocks = JSON.parse(persisted.content) as Array<{
      type: string;
      content: string;
    }>;
    expect(blocks[0].content).not.toContain("sk-ant-api03-");
    expect(blocks[0].content).toContain("<redacted");
  });

  test("redacts GitHub PAT in tool result content before persistence", async () => {
    // Pattern requires 36+ chars after "ghp_"
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";
    state.pendingToolResults.set("tool-use-2", {
      content: `token=${secret}`,
      isError: false,
    });

    await handleMessageComplete(state, makeDeps(), makeMessageCompleteEvent("done"));

    const persisted = lastPersisted("user");
    const blocks = JSON.parse(persisted.content) as Array<{
      type: string;
      content: string;
    }>;
    expect(blocks[0].content).not.toContain("ghp_");
    expect(blocks[0].content).toContain("<redacted");
  });

  test("does not redact non-secret content (UUID, hex hash) in tool result", async () => {
    const safe = "id=550e8400-e29b-41d4-a716-446655440000 sha=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";
    state.pendingToolResults.set("tool-use-3", {
      content: safe,
      isError: false,
    });

    await handleMessageComplete(state, makeDeps(), makeMessageCompleteEvent("done"));

    const persisted = lastPersisted("user");
    const blocks = JSON.parse(persisted.content) as Array<{
      type: string;
      content: string;
    }>;
    expect(blocks[0].content).toBe(safe);
  });

  test("live model state (pendingToolResults) is not modified by persistence redaction", async () => {
    const secret =
      "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" +
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const originalContent = `key=${secret}`;
    state.pendingToolResults.set("tool-use-4", {
      content: originalContent,
      isError: false,
    });

    // Capture the content before handleMessageComplete clears pendingToolResults
    const contentSnapshot = state.pendingToolResults.get("tool-use-4")!.content;

    await handleMessageComplete(state, makeDeps(), makeMessageCompleteEvent("done"));

    // The snapshot taken from live state before the call must be unmodified
    expect(contentSnapshot).toBe(originalContent);
    expect(contentSnapshot).toContain("sk-ant-api03-");
  });

  // ── Assistant message text ───────────────────────────────────────────────

  test("redacts known-pattern secret quoted in assistant text before persistence", async () => {
    const secret =
      "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" +
      "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const text = `Your API key is \`${secret}\`. Keep it safe.`;

    await handleMessageComplete(state, makeDeps(), makeMessageCompleteEvent(text));

    const persisted = lastPersisted("assistant");
    const blocks = JSON.parse(persisted.content) as Array<{
      type: string;
      text?: string;
    }>;
    const textBlock = blocks.find((b) => b.type === "text");
    expect(textBlock?.text).not.toContain("sk-ant-api03-");
    expect(textBlock?.text).toContain("<redacted");
  });

  test("redacts OpenAI Project Key quoted in assistant text before persistence", async () => {
    // Pattern requires 40+ chars after "sk-proj-"
    const secret = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrst";
    const text = `I found this key in the config: ${secret}`;

    await handleMessageComplete(state, makeDeps(), makeMessageCompleteEvent(text));

    const persisted = lastPersisted("assistant");
    const blocks = JSON.parse(persisted.content) as Array<{
      type: string;
      text?: string;
    }>;
    const textBlock = blocks.find((b) => b.type === "text");
    expect(textBlock?.text).not.toContain("sk-proj-");
    expect(textBlock?.text).toContain("<redacted");
  });

  test("does not redact non-secret text in assistant message", async () => {
    const safe = "Here is the file list: index.ts, util.ts, main.ts";

    await handleMessageComplete(state, makeDeps(), makeMessageCompleteEvent(safe));

    const persisted = lastPersisted("assistant");
    const blocks = JSON.parse(persisted.content) as Array<{
      type: string;
      text?: string;
    }>;
    const textBlock = blocks.find((b) => b.type === "text");
    expect(textBlock?.text).toBe(safe);
  });

  test("does not redact random-looking strings that lack known prefixes", async () => {
    // High-entropy but no known credential prefix — should NOT be redacted
    const text = "checksum: 8f14e45fceea167a5a36dedd4bea2543";

    await handleMessageComplete(state, makeDeps(), makeMessageCompleteEvent(text));

    const persisted = lastPersisted("assistant");
    const blocks = JSON.parse(persisted.content) as Array<{
      type: string;
      text?: string;
    }>;
    const textBlock = blocks.find((b) => b.type === "text");
    expect(textBlock?.text).toBe(text);
  });
});
