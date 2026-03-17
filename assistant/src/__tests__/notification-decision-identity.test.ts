/**
 * Tests for identity context threading in the notification decision engine.
 *
 * Validates that buildCoreIdentityContext() output is included in the LLM
 * system prompt when available and omitted when null, and that the fallback
 * path is unaffected by identity context.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks (must precede imports from mocked modules) ──────────────────

mock.module("../channels/config.js", () => ({
  getDeliverableChannels: () => ["vellum"],
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    notifications: {
      decisionModelIntent: "latency-optimized",
    },
  }),
}));

mock.module("../notifications/decisions-store.js", () => ({
  createDecision: () => {},
}));

mock.module("../notifications/preference-summary.js", () => ({
  getPreferenceSummary: () => undefined,
}));

mock.module("../notifications/conversation-candidates.js", () => ({
  buildConversationCandidates: () => undefined,
  serializeCandidatesForPrompt: () => undefined,
}));

// ── Identity context mock ─────────────────────────────────────────────

let mockIdentityContext: string | null = null;
mock.module("../prompts/system-prompt.js", () => ({
  buildCoreIdentityContext: () => mockIdentityContext,
}));

// ── Provider mock with system prompt capture ──────────────────────────

let configuredProvider: {
  sendMessage: (...args: unknown[]) => Promise<unknown>;
} | null = null;
let extractedToolUse: unknown = null;
let capturedSystemPrompt: string | undefined;

mock.module("../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => configuredProvider,
  createTimeout: () => ({
    signal: new AbortController().signal,
    cleanup: () => {},
  }),
  extractToolUse: () => extractedToolUse,
  userMessage: (text: string) => ({ role: "user", content: text }),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ── Imports (after all mocks) ─────────────────────────────────────────

import { evaluateSignal } from "../notifications/decision-engine.js";
import type { NotificationSignal } from "../notifications/signal.js";
import type { NotificationChannel } from "../notifications/types.js";

// ── Helpers ───────────────────────────────────────────────────────────

function makeSignal(
  overrides?: Partial<NotificationSignal>,
): NotificationSignal {
  return {
    signalId: "sig-identity-test-1",
    createdAt: Date.now(),
    sourceChannel: "phone",
    sourceContextId: "call-session-1",
    sourceEventName: "guardian.question",
    contextPayload: {
      questionText: "What is the gate code?",
    },
    attentionHints: {
      requiresAction: true,
      urgency: "high",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("identity context in notification decision engine", () => {
  beforeEach(() => {
    configuredProvider = null;
    extractedToolUse = null;
    mockIdentityContext = null;
    capturedSystemPrompt = undefined;
  });

  test("identity context appears in system prompt when available", async () => {
    mockIdentityContext = "I am Jarvis, a helpful assistant";

    configuredProvider = {
      sendMessage: async (
        _messages: unknown,
        _tools: unknown,
        systemPrompt: unknown,
      ) => {
        capturedSystemPrompt = systemPrompt as string;
        return { content: [] };
      },
    };
    extractedToolUse = {
      name: "record_notification_decision",
      input: {
        shouldNotify: true,
        selectedChannels: ["vellum"],
        reasoningSummary: "LLM decision with identity",
        renderedCopy: {
          vellum: {
            title: "Guardian Question",
            body: "What is the gate code?",
          },
        },
        dedupeKey: "identity-present-test",
        confidence: 0.9,
      },
    };

    const signal = makeSignal();
    await evaluateSignal(signal, ["vellum"] as NotificationChannel[]);

    expect(capturedSystemPrompt).toBeDefined();
    expect(capturedSystemPrompt).toContain("<assistant-identity>");
    expect(capturedSystemPrompt).toContain("I am Jarvis, a helpful assistant");
    expect(capturedSystemPrompt).toContain("</assistant-identity>");
  });

  test("identity context is omitted when buildCoreIdentityContext returns null", async () => {
    mockIdentityContext = null;

    configuredProvider = {
      sendMessage: async (
        _messages: unknown,
        _tools: unknown,
        systemPrompt: unknown,
      ) => {
        capturedSystemPrompt = systemPrompt as string;
        return { content: [] };
      },
    };
    extractedToolUse = {
      name: "record_notification_decision",
      input: {
        shouldNotify: true,
        selectedChannels: ["vellum"],
        reasoningSummary: "LLM decision without identity",
        renderedCopy: {
          vellum: {
            title: "Guardian Question",
            body: "What is the gate code?",
          },
        },
        dedupeKey: "identity-absent-test",
        confidence: 0.9,
      },
    };

    const signal = makeSignal();
    await evaluateSignal(signal, ["vellum"] as NotificationChannel[]);

    expect(capturedSystemPrompt).toBeDefined();
    expect(capturedSystemPrompt).not.toContain("<assistant-identity>");
    expect(capturedSystemPrompt).not.toContain("</assistant-identity>");
  });

  test("fallback path does not include identity context", async () => {
    mockIdentityContext = "I am Jarvis, a helpful assistant";

    // configuredProvider = null forces the fallback path
    configuredProvider = null;

    const signal = makeSignal();
    const decision = await evaluateSignal(signal, [
      "vellum",
    ] as NotificationChannel[]);

    // Fallback should produce valid copy regardless of identity context
    expect(decision.fallbackUsed).toBe(true);
    expect(decision.shouldNotify).toBe(true);
    expect(decision.renderedCopy.vellum?.title).toBeDefined();
    expect(decision.renderedCopy.vellum?.body).toBeDefined();

    // No LLM call was made so no system prompt was captured
    expect(capturedSystemPrompt).toBeUndefined();
  });
});
