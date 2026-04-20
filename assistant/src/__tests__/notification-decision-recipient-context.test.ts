/**
 * Tests for recipient context (guardian contact notes) injection in the
 * notification decision engine.
 *
 * Validates that guardian contact notes appear in the LLM system prompt as
 * a <recipient-context> block when available, are omitted when absent or
 * empty, and are truncated when large.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks (must precede imports from mocked modules) ──────────────────

mock.module("../channels/config.js", () => ({
  getDeliverableChannels: () => ["vellum"],
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

mock.module("../prompts/persona-resolver.js", () => ({
  resolveGuardianPersona: () => null,
}));

mock.module("../prompts/system-prompt.js", () => ({
  buildCoreIdentityContext: () => null,
}));

// ── Guardian contact mock ────────────────────────────────────────────

let mockGuardianResult: {
  contact: { notes: string | null };
  channels: Record<string, unknown>[];
} | null = null;

mock.module("../contacts/contact-store.js", () => ({
  listGuardianChannels: () => mockGuardianResult,
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
    signalId: "sig-recipient-ctx-test-1",
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

function setupLLMProvider() {
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
      reasoningSummary: "LLM decision with recipient context",
      renderedCopy: {
        vellum: {
          title: "Guardian Question",
          body: "What is the gate code?",
        },
      },
      dedupeKey: "recipient-ctx-test",
      confidence: 0.9,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("recipient context in notification decision engine", () => {
  beforeEach(() => {
    configuredProvider = null;
    extractedToolUse = null;
    mockGuardianResult = null;
    capturedSystemPrompt = undefined;
  });

  test("guardian contact notes appear in system prompt as <recipient-context>", async () => {
    mockGuardianResult = {
      contact: { notes: "Prefers formal tone. Address as Dr. Smith." },
      channels: [{ type: "vellum" }],
    };
    setupLLMProvider();

    const signal = makeSignal();
    await evaluateSignal(signal, ["vellum"] as NotificationChannel[]);

    expect(capturedSystemPrompt).toBeDefined();
    expect(capturedSystemPrompt).toContain("<recipient-context>");
    expect(capturedSystemPrompt).toContain(
      "Prefers formal tone. Address as Dr. Smith.",
    );
    expect(capturedSystemPrompt).toContain("</recipient-context>");
  });

  test("recipient-context is omitted when no guardian exists", async () => {
    mockGuardianResult = null;
    setupLLMProvider();

    const signal = makeSignal();
    await evaluateSignal(signal, ["vellum"] as NotificationChannel[]);

    expect(capturedSystemPrompt).toBeDefined();
    expect(capturedSystemPrompt).not.toContain("<recipient-context>");
    expect(capturedSystemPrompt).not.toContain("</recipient-context>");
  });

  test("recipient-context is omitted when guardian notes are null", async () => {
    mockGuardianResult = {
      contact: { notes: null },
      channels: [{ type: "vellum" }],
    };
    setupLLMProvider();

    const signal = makeSignal();
    await evaluateSignal(signal, ["vellum"] as NotificationChannel[]);

    expect(capturedSystemPrompt).toBeDefined();
    expect(capturedSystemPrompt).not.toContain("<recipient-context>");
    expect(capturedSystemPrompt).not.toContain("</recipient-context>");
  });

  test("recipient-context is omitted when guardian notes are empty string", async () => {
    mockGuardianResult = {
      contact: { notes: "" },
      channels: [{ type: "vellum" }],
    };
    setupLLMProvider();

    const signal = makeSignal();
    await evaluateSignal(signal, ["vellum"] as NotificationChannel[]);

    expect(capturedSystemPrompt).toBeDefined();
    expect(capturedSystemPrompt).not.toContain("<recipient-context>");
    expect(capturedSystemPrompt).not.toContain("</recipient-context>");
  });

  test("large guardian notes are truncated to prevent oversized prompts", async () => {
    mockGuardianResult = {
      contact: { notes: "N".repeat(3000) },
      channels: [{ type: "vellum" }],
    };
    setupLLMProvider();

    const signal = makeSignal();
    await evaluateSignal(signal, ["vellum"] as NotificationChannel[]);

    expect(capturedSystemPrompt).toBeDefined();
    expect(capturedSystemPrompt).toContain("<recipient-context>");
    // Full 3000-char string should NOT appear
    expect(capturedSystemPrompt).not.toContain("N".repeat(3000));
    // Truncation marker should be present
    expect(capturedSystemPrompt).toContain("\u2026[truncated]");

    const match = capturedSystemPrompt!.match(
      /<recipient-context>([\s\S]*?)<\/recipient-context>/,
    );
    expect(match).toBeTruthy();
    const block = match![1];
    expect(block).toContain("\u2026[truncated]");
    // The notes portion within the block should not exceed 2000 chars
    expect(block).not.toContain("N".repeat(2001));
  });

  test("fallback path works correctly without recipient context", async () => {
    mockGuardianResult = {
      contact: { notes: "Prefers formal tone." },
      channels: [{ type: "vellum" }],
    };
    // null provider forces fallback path
    configuredProvider = null;

    const signal = makeSignal();
    const decision = await evaluateSignal(signal, [
      "vellum",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(true);
    expect(decision.shouldNotify).toBe(true);
    expect(decision.renderedCopy.vellum?.title).toBeDefined();
    expect(decision.renderedCopy.vellum?.body).toBeDefined();
    // No LLM call, so no system prompt captured
    expect(capturedSystemPrompt).toBeUndefined();
  });

  test("recipient-context appears after user-preferences in prompt", async () => {
    mockGuardianResult = {
      contact: { notes: "Prefers brief updates." },
      channels: [{ type: "vellum" }],
    };
    setupLLMProvider();

    const signal = makeSignal();
    await evaluateSignal(
      signal,
      ["vellum"] as NotificationChannel[],
      "Notify only for urgent items",
    );

    expect(capturedSystemPrompt).toBeDefined();
    const prefsIdx = capturedSystemPrompt!.indexOf("</user-preferences>");
    const recipientIdx = capturedSystemPrompt!.indexOf("<recipient-context>");
    expect(prefsIdx).toBeGreaterThan(-1);
    expect(recipientIdx).toBeGreaterThan(-1);
    expect(recipientIdx).toBeGreaterThan(prefsIdx);
  });
});
