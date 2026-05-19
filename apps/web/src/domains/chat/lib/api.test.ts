import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks — registered before the subject module is imported so the
// happy-path (mocked Capacitor + Sentry) is exercised, not the defensive
// fallback. Mirrors the convention in network-status.test.ts.
// ---------------------------------------------------------------------------

let mockedPlatform = "web";

// `recordChatDiagnostic` reads `Capacitor.getPlatform()` to tag every event.
// Without this mock, bun's transpiler can leave the named import as a stub
// (Capacitor.getPlatform is undefined), forcing the diagnostics module's
// defensive fallback to take over. The fallback is correct in production but
// hides the real production code path from coverage; mocking the named
// import surfaces the platform tag exactly the way runtime would.
mock.module("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => mockedPlatform,
  },
}));

interface SentryBreadcrumbCall {
  category?: string;
  level?: string;
  message?: string;
  data?: Record<string, unknown>;
}
interface SentryCaptureMessageCall {
  message: string;
  level?: string;
  tags?: Record<string, string>;
  extra?: Record<string, unknown>;
}

const sentryBreadcrumbs: SentryBreadcrumbCall[] = [];
const sentryCaptureMessages: SentryCaptureMessageCall[] = [];

// The watchdog and post-reconnect reconcile mirror their diagnostics into
// Sentry so fleet-wide passive telemetry can answer the L2/L3 question even
// when users never submit a support snapshot. Capturing every call makes
// those code paths assertable.
mock.module("@sentry/nextjs", () => ({
  addBreadcrumb: (crumb: SentryBreadcrumbCall) => {
    sentryBreadcrumbs.push(crumb);
  },
  captureMessage: (
    message: string,
    options?: {
      level?: string;
      tags?: Record<string, string>;
      extra?: Record<string, unknown>;
    },
  ) => {
    sentryCaptureMessages.push({
      message,
      level: options?.level,
      tags: options?.tags,
      extra: options?.extra,
    });
  },
  captureException: () => {},
}));

import {
  normalizeContentOrder,
  normalizeTextSegments,
  parseAssistantEvent,
  parseConversation,
  postChatMessage,
  subscribeChatEvents,
  toDisplayAttachments,
  type ChatStreamReconnectCause,
} from "@/domains/chat/lib/api.js";
import {
  getChatDiagnosticsEvents,
  recordChatDiagnostic,
} from "@/domains/chat/lib/diagnostics.js";
import {
  type TurnState,
  INITIAL_TURN_STATE,
  turnReducer,
  isSending,
} from "@/domains/chat/lib/turn-state-machine.js";
import { SYNC_TAGS } from "@/lib/sync/types.js";

describe("parseAssistantEvent", () => {
  test("parses assistant_text_delta", () => {
    const event = parseAssistantEvent("assistant_text_delta", {
      text: "Hello",
      messageId: "msg-1",
    });
    expect(event).toEqual({
      type: "assistant_text_delta",
      text: "Hello",
      messageId: "msg-1",
    });
  });

  test("maps assistant_text_delta conversationId to conversationKey", () => {
    const event = parseAssistantEvent("assistant_text_delta", {
      text: "Hello",
      messageId: "msg-1",
      conversationId: "conversation-1",
    });
    expect(event).toEqual({
      type: "assistant_text_delta",
      text: "Hello",
      messageId: "msg-1",
      conversationKey: "conversation-1",
    });
  });

  test("defaults text to empty string when missing", () => {
    const event = parseAssistantEvent("assistant_text_delta", {});
    expect(event).toEqual({
      type: "assistant_text_delta",
      text: "",
      messageId: undefined,
    });
  });

  test("parses message_complete with content", () => {
    const event = parseAssistantEvent("message_complete", {
      messageId: "msg-1",
      displayMessageId: "display-msg-1",
      content: "Full response",
    });
    expect(event).toEqual({
      type: "message_complete",
      messageId: "msg-1",
      displayMessageId: "display-msg-1",
      content: "Full response",
      attachments: undefined,
    });
  });

  test("preserves message_complete conversationKey", () => {
    const event = parseAssistantEvent("message_complete", {
      messageId: "msg-1",
      content: "Full response",
      conversationKey: "conversation-1",
    });
    expect(event).toEqual({
      type: "message_complete",
      messageId: "msg-1",
      content: "Full response",
      attachments: undefined,
      conversationKey: "conversation-1",
    });
  });

  test("parses message_complete without content", () => {
    const event = parseAssistantEvent("message_complete", {});
    expect(event).toEqual({
      type: "message_complete",
      messageId: undefined,
      content: undefined,
      attachments: undefined,
    });
  });

  test("parses message_complete with attachments", () => {
    const event = parseAssistantEvent("message_complete", {
      messageId: "msg-1",
      content: "Here is the screenshot",
      attachments: [
        {
          id: "att-1",
          filename: "screenshot.png",
          mimeType: "image/png",
          data: "iVBORw0KGgo=",
          sourceType: "sandbox_file",
        },
      ],
    });
    expect(event).toEqual({
      type: "message_complete",
      messageId: "msg-1",
      content: "Here is the screenshot",
      attachments: [
        {
          id: "att-1",
          filename: "screenshot.png",
          mimeType: "image/png",
          data: "iVBORw0KGgo=",
          sourceType: "sandbox_file",
          sizeBytes: undefined,
          thumbnailData: undefined,
          fileBacked: undefined,
        },
      ],
    });
  });

  test("parses message_complete ignoring invalid attachments", () => {
    const event = parseAssistantEvent("message_complete", {
      content: "text",
      attachments: [{ bad: true }, { filename: "ok.txt", mimeType: "text/plain" }],
    });
    expect(event).toEqual({
      type: "message_complete",
      messageId: undefined,
      content: "text",
      attachments: [
        {
          id: undefined,
          filename: "ok.txt",
          mimeType: "text/plain",
          data: "",
          sourceType: undefined,
          sizeBytes: undefined,
          thumbnailData: undefined,
          fileBacked: undefined,
        },
      ],
    });
  });

  test("parses generation_handoff", () => {
    const event = parseAssistantEvent("generation_handoff", {
      messageId: "msg-1",
      displayMessageId: "display-msg-1",
    });
    expect(event).toEqual({
      type: "generation_handoff",
      messageId: "msg-1",
      displayMessageId: "display-msg-1",
      attachments: undefined,
    });
  });

  test("parses error with code and message", () => {
    const event = parseAssistantEvent("error", {
      code: "rate_limit_exceeded",
      message: "Too many requests",
    });
    expect(event).toEqual({
      type: "error",
      code: "rate_limit_exceeded",
      message: "Too many requests",
    });
  });

  test("preserves categorized stream error metadata", () => {
    const event = parseAssistantEvent("error", {
      code: "PROVIDER_BILLING",
      errorCategory: "credits_exhausted",
      message: "Your balance has run out",
    });
    expect(event).toEqual({
      type: "error",
      code: "PROVIDER_BILLING",
      errorCategory: "credits_exhausted",
      message: "Your balance has run out",
    });
  });

  test("defaults error message to 'Unknown error' when missing", () => {
    const event = parseAssistantEvent("error", {});
    expect(event).toEqual({
      type: "error",
      code: undefined,
      message: "Unknown error",
    });
  });

  test("returns unknown event for unrecognized type", () => {
    const data = { foo: "bar" };
    const event = parseAssistantEvent("some_future_event", data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "some_future_event",
      data,
    });
  });

  test("parses sync_changed tags", () => {
    const event = parseAssistantEvent("sync_changed", {
      tags: [
        SYNC_TAGS.assistantAvatar,
        "conversation:conversation-1:metadata",
        "future:resource",
      ],
    });
    expect(event).toEqual({
      type: "sync_changed",
      tags: [
        SYNC_TAGS.assistantAvatar,
        "conversation:conversation-1:metadata",
        "future:resource",
      ],
    });
  });

  test("returns unknown for sync_changed without a tags array", () => {
    const data = { tag: SYNC_TAGS.assistantAvatar };
    const event = parseAssistantEvent("sync_changed", data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "sync_changed",
      data,
    });
  });

  test("returns unknown for sync_changed with non-string tags", () => {
    const data = { tags: [SYNC_TAGS.assistantAvatar, 42] };
    const event = parseAssistantEvent("sync_changed", data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "sync_changed",
      data,
    });
  });

  test("parses assistant_activity_state idle", () => {
    const event = parseAssistantEvent("assistant_activity_state", {
      conversationId: "conv-1",
      activityVersion: 7,
      phase: "idle",
      anchor: "global",
      reason: "message_complete",
      requestId: "req-abc",
    });
    expect(event).toEqual({
      type: "assistant_activity_state",
      activityVersion: 7,
      phase: "idle",
      anchor: "global",
      reason: "message_complete",
      requestId: "req-abc",
      conversationKey: "conv-1",
    });
  });

  test("parses assistant_activity_state thinking with statusText", () => {
    const event = parseAssistantEvent("assistant_activity_state", {
      conversationId: "conv-1",
      activityVersion: 3,
      phase: "thinking",
      anchor: "assistant_turn",
      reason: "thinking_delta",
      statusText: "Reading file…",
    });
    expect(event).toEqual({
      type: "assistant_activity_state",
      activityVersion: 3,
      phase: "thinking",
      anchor: "assistant_turn",
      reason: "thinking_delta",
      statusText: "Reading file…",
      conversationKey: "conv-1",
    });
  });

  test("parses assistant_activity_state idle with error_terminal reason", () => {
    // Disk-pressure block path emits idle with error_terminal but no
    // follow-up message_complete. The web handler must treat this as
    // terminal so the loading indicator clears.
    const event = parseAssistantEvent("assistant_activity_state", {
      conversationId: "conv-1",
      activityVersion: 1,
      phase: "idle",
      anchor: "global",
      reason: "error_terminal",
    });
    expect(event).toEqual({
      type: "assistant_activity_state",
      activityVersion: 1,
      phase: "idle",
      anchor: "global",
      reason: "error_terminal",
      conversationKey: "conv-1",
    });
  });

  test("returns unknown for assistant_activity_state with invalid phase", () => {
    const data = {
      conversationId: "conv-1",
      activityVersion: 1,
      phase: "definitely_not_a_phase",
      anchor: "global",
      reason: "message_complete",
    };
    const event = parseAssistantEvent("assistant_activity_state", data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "assistant_activity_state",
      data,
      conversationKey: "conv-1",
    });
  });

  test("returns unknown for assistant_activity_state with invalid reason", () => {
    const data = {
      conversationId: "conv-1",
      activityVersion: 1,
      phase: "idle",
      anchor: "global",
      reason: "made_up_reason",
    };
    const event = parseAssistantEvent("assistant_activity_state", data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "assistant_activity_state",
      data,
      conversationKey: "conv-1",
    });
  });

  test("parses open_url", () => {
    const event = parseAssistantEvent("open_url", {
      url: "https://example.com/oauth",
      title: "Connect Google",
    });
    expect(event).toEqual({
      type: "open_url",
      url: "https://example.com/oauth",
      title: "Connect Google",
    });
  });

  test("returns unknown open_url event when url is missing", () => {
    const data = { title: "Connect Google" };
    const event = parseAssistantEvent("open_url", data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "open_url",
      data,
    });
  });

  test("parses navigate_settings", () => {
    const event = parseAssistantEvent("navigate_settings", {
      tab: "Integrations",
    });
    expect(event).toEqual({
      type: "navigate_settings",
      tab: "Integrations",
    });
  });

  test("returns unknown navigate_settings event when tab is missing", () => {
    const data = {};
    const event = parseAssistantEvent("navigate_settings", data);
    expect(event).toEqual({
      type: "unknown",
      rawType: "navigate_settings",
      data,
    });
  });

  test("parses disk_pressure_status_changed", () => {
    const event = parseAssistantEvent("disk_pressure_status_changed", {
      status: {
        enabled: true,
        state: "critical",
        locked: true,
        acknowledged: false,
        overrideActive: false,
        effectivelyLocked: true,
        lockId: "lock-123",
        usagePercent: 94.3,
        thresholdPercent: 90,
        path: "/workspace",
        lastCheckedAt: "2026-05-05T12:00:00.000Z",
        blockedCapabilities: [
          "agent-turns",
          "background-work",
          "remote-ingress",
          "unknown-capability",
        ],
        error: null,
      },
    });

    expect(event).toEqual({
      type: "disk_pressure_status_changed",
      status: {
        enabled: true,
        state: "critical",
        locked: true,
        acknowledged: false,
        overrideActive: false,
        effectivelyLocked: true,
        lockId: "lock-123",
        usagePercent: 94.3,
        thresholdPercent: 90,
        path: "/workspace",
        lastCheckedAt: "2026-05-05T12:00:00.000Z",
        blockedCapabilities: [
          "agent-turns",
          "background-work",
          "remote-ingress",
        ],
        error: null,
      },
      conversationKey: undefined,
    });
  });

  test("parses flat disk_pressure_status_changed payloads", () => {
    const event = parseAssistantEvent("disk_pressure_status_changed", {
      type: "disk_pressure_status_changed",
      enabled: true,
      state: "critical",
      locked: true,
      acknowledged: false,
      overrideActive: false,
      effectivelyLocked: true,
      lockId: "lock-flat",
      usagePercent: 96,
      thresholdPercent: 90,
      path: "/workspace",
      lastCheckedAt: "2026-05-05T12:05:00.000Z",
      blockedCapabilities: ["background-work", "remote-ingress"],
      error: null,
      conversationKey: "conversation-123",
    });

    expect(event).toEqual({
      type: "disk_pressure_status_changed",
      status: {
        enabled: true,
        state: "critical",
        locked: true,
        acknowledged: false,
        overrideActive: false,
        effectivelyLocked: true,
        lockId: "lock-flat",
        usagePercent: 96,
        thresholdPercent: 90,
        path: "/workspace",
        lastCheckedAt: "2026-05-05T12:05:00.000Z",
        blockedCapabilities: ["background-work", "remote-ingress"],
        error: null,
      },
      conversationKey: "conversation-123",
    });
  });

  test("parses disk_pressure_status_changed disabled status", () => {
    const event = parseAssistantEvent("disk_pressure_status_changed", {
      status: {
        enabled: false,
        state: "disabled",
        locked: false,
        acknowledged: false,
        overrideActive: false,
        effectivelyLocked: false,
        lockId: null,
        usagePercent: null,
        thresholdPercent: 90,
        path: null,
        lastCheckedAt: null,
        blockedCapabilities: [],
        error: null,
      },
    });

    expect(event).toEqual({
      type: "disk_pressure_status_changed",
      status: {
        enabled: false,
        state: "disabled",
        locked: false,
        acknowledged: false,
        overrideActive: false,
        effectivelyLocked: false,
        lockId: null,
        usagePercent: null,
        thresholdPercent: 90,
        path: null,
        lastCheckedAt: null,
        blockedCapabilities: [],
        error: null,
      },
      conversationKey: undefined,
    });
  });

  test("ignores non-string fields gracefully", () => {
    const event = parseAssistantEvent("assistant_text_delta", {
      text: 42,
      messageId: true,
    });
    expect(event).toEqual({
      type: "assistant_text_delta",
      text: "",
      messageId: undefined,
    });
  });

  test("parses secret_request with all fields", () => {
    const event = parseAssistantEvent("secret_request", {
      requestId: "req-1",
      service: "github",
      field: "token",
      label: "GitHub Token",
      description: "Enter your personal access token",
      placeholder: "ghp_...",
      allowOneTimeSend: true,
    });
    expect(event).toEqual({
      type: "secret_request",
      requestId: "req-1",
      service: "github",
      field: "token",
      label: "GitHub Token",
      description: "Enter your personal access token",
      placeholder: "ghp_...",
      allowOneTimeSend: true,
    });
  });

  test("defaults secret_request requestId to empty string", () => {
    const event = parseAssistantEvent("secret_request", {});
    expect(event).toEqual({
      type: "secret_request",
      requestId: "",
      service: undefined,
      field: undefined,
      label: undefined,
      description: undefined,
      placeholder: undefined,
      allowOneTimeSend: undefined,
    });
  });

  describe("confirmation_request", () => {
    test("parses confirmation_request with toolUseId", () => {
      const event = parseAssistantEvent("confirmation_request", {
        requestId: "req-1",
        title: "Allow file write?",
        toolName: "write_file",
        toolUseId: "tool-use-42",
        riskLevel: "high",
      });
      expect(event).toEqual({
        type: "confirmation_request",
        requestId: "req-1",
        title: "Allow file write?",
        description: undefined,
        confirmLabel: undefined,
        denyLabel: undefined,
        toolName: "write_file",
        executionTarget: undefined,
        riskLevel: "high",
        riskReason: undefined,
        allowlistOptions: undefined,
        scopeOptions: undefined,
        directoryScopeOptions: undefined,
        persistentDecisionsAllowed: undefined,
        input: undefined,
        toolUseId: "tool-use-42",
      });
    });

    test("parses confirmation_request without toolUseId", () => {
      const event = parseAssistantEvent("confirmation_request", {
        requestId: "req-2",
        title: "Allow shell command?",
        toolName: "bash",
      });
      expect(event.type).toBe("confirmation_request");
      if (event.type === "confirmation_request") {
        expect(event.requestId).toBe("req-2");
        expect(event.toolUseId).toBeUndefined();
      }
    });

    test("ignores non-string toolUseId", () => {
      const event = parseAssistantEvent("confirmation_request", {
        requestId: "req-3",
        toolUseId: 12345,
      });
      expect(event.type).toBe("confirmation_request");
      if (event.type === "confirmation_request") {
        expect(event.toolUseId).toBeUndefined();
      }
    });

    test("parses full confirmation_request with allowlist and scope options", () => {
      const event = parseAssistantEvent("confirmation_request", {
        requestId: "req-full",
        title: "Allow bash command?",
        description: "ls -la /tmp",
        confirmLabel: "Allow",
        denyLabel: "Deny",
        toolName: "bash",
        executionTarget: "sandbox",
        riskLevel: "medium",
        riskReason: "Filesystem access",
        toolUseId: "tool-use-99",
        allowlistOptions: [
          { pattern: "Bash(*)", label: "Allow all bash commands" },
        ],
        scopeOptions: [
          { scope: "workspace", label: "Current workspace" },
        ],
        directoryScopeOptions: [
          { scope: "/src", label: "Source directory" },
        ],
        persistentDecisionsAllowed: true,
        input: { command: "ls -la /tmp" },
      });
      expect(event.type).toBe("confirmation_request");
      if (event.type === "confirmation_request") {
        expect(event.requestId).toBe("req-full");
        expect(event.toolUseId).toBe("tool-use-99");
        expect(event.allowlistOptions).toEqual([
          { pattern: "Bash(*)", label: "Allow all bash commands" },
        ]);
        expect(event.scopeOptions).toEqual([
          { scope: "workspace", label: "Current workspace" },
        ]);
        expect(event.directoryScopeOptions).toEqual([
          { scope: "/src", label: "Source directory" },
        ]);
        expect(event.persistentDecisionsAllowed).toBe(true);
        expect(event.input).toEqual({ command: "ls -la /tmp" });
      }
    });

    test("defaults requestId to empty string when missing", () => {
      const event = parseAssistantEvent("confirmation_request", {
        title: "Confirm?",
      });
      expect(event.type).toBe("confirmation_request");
      if (event.type === "confirmation_request") {
        expect(event.requestId).toBe("");
      }
    });

    test("ignores non-array allowlistOptions and non-boolean persistentDecisionsAllowed", () => {
      const event = parseAssistantEvent("confirmation_request", {
        requestId: "req-invalid",
        allowlistOptions: "not-an-array",
        persistentDecisionsAllowed: "yes",
        input: [1, 2, 3],
      });
      expect(event.type).toBe("confirmation_request");
      if (event.type === "confirmation_request") {
        expect(event.allowlistOptions).toBeUndefined();
        expect(event.persistentDecisionsAllowed).toBeUndefined();
        expect(event.input).toBeUndefined();
      }
    });
  });

  describe("tool_result", () => {
    test("maps riskAllowlistOptions → allowlistOptions (Minimatch save-path) and riskDirectoryScopeOptions → directoryScopeOptions", () => {
      const event = parseAssistantEvent("tool_result", {
        toolName: "bash",
        result: "ok",
        riskLevel: "medium",
        riskAllowlistOptions: [
          { pattern: "ls -la", label: "Just this command", description: "Allow only `ls -la`" },
          { pattern: "action:ls", label: "All ls commands", description: "Allow any `ls …` invocation" },
        ],
        riskDirectoryScopeOptions: [
          { scope: "/home/user/project", label: "Project directory" },
        ],
      });
      expect(event.type).toBe("tool_result");
      if (event.type === "tool_result") {
        expect(event.allowlistOptions).toEqual([
          { pattern: "ls -la", label: "Just this command", description: "Allow only `ls -la`" },
          { pattern: "action:ls", label: "All ls commands", description: "Allow any `ls …` invocation" },
        ]);
        expect(event.directoryScopeOptions).toEqual([
          { scope: "/home/user/project", label: "Project directory" },
        ]);
      }
    });

    test("does NOT promote riskScopeOptions into allowlistOptions (display-only ladder is not save-path)", () => {
      // riskScopeOptions can carry regex-flavored descriptors that are NOT
      // valid Minimatch trust rule patterns. Saving them would produce a
      // rule that never matches future calls. This test guards against
      // regression of the pre-PR-29826 conflation bug where the deserializer
      // cast `riskScopeOptions` into `allowlistOptions`.
      const event = parseAssistantEvent("tool_result", {
        toolName: "bash",
        result: "ok",
        riskScopeOptions: [
          { pattern: "^bash\\(ls.*\\)$", label: "All ls commands" },
        ],
      });
      expect(event.type).toBe("tool_result");
      if (event.type === "tool_result") {
        expect(event.allowlistOptions).toBeUndefined();
        expect(event.directoryScopeOptions).toBeUndefined();
      }
    });

    test("returns undefined allowlistOptions when riskAllowlistOptions is missing", () => {
      const event = parseAssistantEvent("tool_result", {
        toolName: "remember",
        result: "saved",
      });
      expect(event.type).toBe("tool_result");
      if (event.type === "tool_result") {
        expect(event.allowlistOptions).toBeUndefined();
        expect(event.directoryScopeOptions).toBeUndefined();
      }
    });

    test("does not read top-level allowlistOptions on tool_result (wire field is riskAllowlistOptions)", () => {
      // The daemon sends `riskAllowlistOptions` on tool_result, not the
      // un-prefixed `allowlistOptions` (that field is reserved for
      // confirmation_request). Guard against regression to a wrong-field read.
      const event = parseAssistantEvent("tool_result", {
        toolName: "bash",
        result: "ok",
        allowlistOptions: [{ pattern: "bash(*)", label: "All bash" }],
      });
      expect(event.type).toBe("tool_result");
      if (event.type === "tool_result") {
        expect(event.allowlistOptions).toBeUndefined();
      }
    });
  });

  test("preserves surfaceType verbatim without coercion", () => {
    const event = parseAssistantEvent("ui_surface_show", {
      surfaceId: "s-1",
      surfaceType: "custom_widget",
      data: { key: "value" },
    });
    expect(event).toEqual({
      type: "ui_surface_show",
      surfaceId: "s-1",
      surfaceType: "custom_widget",
      title: undefined,
      data: { key: "value" },
      actions: undefined,
      display: undefined,
      messageId: undefined,
    });
  });

  test("preserves known surfaceType values as-is", () => {
    const event = parseAssistantEvent("ui_surface_show", {
      surfaceId: "s-2",
      surfaceType: "form",
      data: {},
    });
    expect(event.type).toBe("ui_surface_show");
    if (event.type === "ui_surface_show") {
      expect(event.surfaceType).toBe("form");
    }
  });

  test("defaults surfaceType to 'card' when not a string", () => {
    const event = parseAssistantEvent("ui_surface_show", {
      surfaceId: "s-3",
      surfaceType: 42,
      data: {},
    });
    expect(event.type).toBe("ui_surface_show");
    if (event.type === "ui_surface_show") {
      expect(event.surfaceType).toBe("card");
    }
  });

  test("parses notification_intent with deep-link metadata", () => {
    const event = parseAssistantEvent("notification_intent", {
      deliveryId: "del-1",
      sourceEventName: "chat.assistant_turn_complete",
      title: "New message",
      body: "Hello world",
      deepLinkMetadata: { conversationId: "conv-42" },
    });
    expect(event).toEqual({
      type: "notification_intent",
      deliveryId: "del-1",
      sourceEventName: "chat.assistant_turn_complete",
      title: "New message",
      body: "Hello world",
      deepLinkMetadata: { conversationId: "conv-42" },
      targetGuardianPrincipalId: undefined,
    });
  });

  test("notification_intent preserves targetGuardianPrincipalId", () => {
    const event = parseAssistantEvent("notification_intent", {
      sourceEventName: "guardian.question",
      title: "Guardian check-in",
      body: "Approve this request?",
      targetGuardianPrincipalId: "guardian-7",
    });
    expect(event.type).toBe("notification_intent");
    if (event.type === "notification_intent") {
      expect(event.targetGuardianPrincipalId).toBe("guardian-7");
    }
  });

  test("notification_intent without title falls through to unknown", () => {
    const event = parseAssistantEvent("notification_intent", {
      sourceEventName: "chat.assistant_turn_complete",
      body: "missing title",
    });
    expect(event.type).toBe("unknown");
  });

  test("notification_intent with non-object deepLinkMetadata is ignored", () => {
    const event = parseAssistantEvent("notification_intent", {
      sourceEventName: "chat.assistant_turn_complete",
      title: "Hello",
      body: "Body",
      deepLinkMetadata: "not-an-object",
    });
    expect(event.type).toBe("notification_intent");
    if (event.type === "notification_intent") {
      expect(event.deepLinkMetadata).toBeUndefined();
    }
  });

  describe("identity_changed", () => {
    test("parses to a typed invalidation signal regardless of payload", () => {
      // Arbitrary payload — handler treats this as an invalidation-only signal
      // and refetches identity from the canonical endpoint.
      const event = parseAssistantEvent("identity_changed", {
        name: "Pax",
        role: "assistant",
      });
      expect(event.type).toBe("identity_changed");
    });

    test("empty payload still produces IdentityChangedEvent (not UnknownEvent)", () => {
      const event = parseAssistantEvent("identity_changed", {});
      expect(event.type).toBe("identity_changed");
    });
  });
});

// ---------------------------------------------------------------------------
// Polling reconciliation integration with turn state machine
// ---------------------------------------------------------------------------

describe("polling reconciliation with state machine", () => {
  /**
   * Simulates the page-level flow where polling completion dispatches a
   * POLL_RECONCILED event through the turn reducer.  These tests verify
   * the contract between the polling path and the state machine.
   */

  test("poll completion transitions active turn to idle", () => {
    // Simulate: user sends (thinking) -> poll finds reply -> dispatch POLL_RECONCILED
    const afterSend = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-poll-1",
    });
    expect(isSending(afterSend)).toBe(true);

    const afterPoll = turnReducer(afterSend, {
      type: "POLL_RECONCILED",
      turnId: "t-poll-1",
    });
    expect(afterPoll.phase).toBe("idle");
    expect(isSending(afterPoll)).toBe(false);
    expect(afterPoll.lastTerminalReason).toBe("complete");
  });

  test("SSE completes before poll — poll for same turnId is no-op", () => {
    // SSE path: send -> delta -> message_complete
    let state = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-race-1",
    });
    state = turnReducer(state, { type: "ASSISTANT_TEXT_DELTA" });
    state = turnReducer(state, { type: "MESSAGE_COMPLETE" });
    expect(state.phase).toBe("idle");
    expect(state.activeTurnId).toBeNull();

    // Poll arrives late for the same turn — should be a no-op
    const afterPoll = turnReducer(state, {
      type: "POLL_RECONCILED",
      turnId: "t-race-1",
    });
    expect(afterPoll).toEqual(state);
  });

  test("poll completes before SSE — SSE message_complete is idempotent", () => {
    // Poll path completes first
    let state = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-race-2",
    });
    state = turnReducer(state, {
      type: "POLL_RECONCILED",
      turnId: "t-race-2",
    });
    expect(state.phase).toBe("idle");

    // SSE message_complete arrives late — already idle, idempotent
    const afterSSE = turnReducer(state, { type: "MESSAGE_COMPLETE" });
    expect(afterSSE.phase).toBe("idle");
    expect(afterSSE.lastTerminalReason).toBe("complete");
  });

  test("stale poll does not interfere with new turn", () => {
    // Turn 1: send -> complete
    let state = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-old",
    });
    state = turnReducer(state, { type: "MESSAGE_COMPLETE" });

    // Turn 2: send (now active)
    state = turnReducer(state, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-new",
    });
    expect(state.activeTurnId).toBe("t-new");
    expect(state.phase).toBe("thinking");

    // Stale poll from turn 1 arrives — should NOT affect turn 2
    const afterStalePoll = turnReducer(state, {
      type: "POLL_RECONCILED",
      turnId: "t-old",
    });
    expect(afterStalePoll.phase).toBe("thinking");
    expect(afterStalePoll.activeTurnId).toBe("t-new");
  });

  test("poll without turnId still works for backward compatibility", () => {
    const afterSend = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-compat",
    });
    // Legacy-style poll without turnId
    const afterPoll = turnReducer(afterSend, {
      type: "POLL_RECONCILED",
    });
    expect(afterPoll.phase).toBe("idle");
    expect(afterPoll.lastTerminalReason).toBe("complete");
  });

  test("SSE events mapped from wire format produce correct domain events", () => {
    // Verify that parseAssistantEvent produces events that map correctly
    // to domain events consumed by the reducer
    const delta = parseAssistantEvent("assistant_text_delta", {
      text: "hello",
    });
    expect(delta.type).toBe("assistant_text_delta");

    const complete = parseAssistantEvent("message_complete", {
      content: "done",
    });
    expect(complete.type).toBe("message_complete");

    const handoff = parseAssistantEvent("generation_handoff", {});
    expect(handoff.type).toBe("generation_handoff");

    const error = parseAssistantEvent("error", { message: "fail" });
    expect(error.type).toBe("error");

    // The page maps these wire types to domain event types:
    // assistant_text_delta -> ASSISTANT_TEXT_DELTA
    // message_complete     -> MESSAGE_COMPLETE
    // generation_handoff   -> GENERATION_HANDOFF
    // error                -> STREAM_ERROR

    // Verify domain events flow correctly through reducer
    let state: TurnState = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-wire",
    });
    state = turnReducer(state, { type: "ASSISTANT_TEXT_DELTA" });
    expect(state.phase).toBe("streaming");
    state = turnReducer(state, { type: "MESSAGE_COMPLETE" });
    expect(state.phase).toBe("idle");
  });

  // ---- activeTurnId guard on idle re-activation ----

  test("ASSISTANT_TEXT_DELTA does NOT re-activate idle when activeTurnId is null", () => {
    let state = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-guard-1",
    });
    state = turnReducer(state, { type: "MESSAGE_COMPLETE" });
    expect(state.phase).toBe("idle");
    expect(state.activeTurnId).toBeNull();

    const afterDelta = turnReducer(state, { type: "ASSISTANT_TEXT_DELTA" });
    expect(afterDelta.phase).toBe("idle");
  });

  test("ASSISTANT_TEXT_DELTA re-activates idle when activeTurnId is set", () => {
    const forcedIdle: TurnState = {
      phase: "idle",
      activeTurnId: "t-guard-2",
      activeToolCallCount: 0,
      pendingQueuedCount: 0,
      lastTerminalReason: null,
      statusText: null,
    };
    const afterDelta = turnReducer(forcedIdle, { type: "ASSISTANT_TEXT_DELTA" });
    expect(afterDelta.phase).toBe("streaming");
    expect(afterDelta.activeTurnId).toBe("t-guard-2");
  });

  test("TOOL_USE_START does NOT re-activate idle when activeTurnId is null", () => {
    let state = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-guard-3",
    });
    state = turnReducer(state, { type: "MESSAGE_COMPLETE" });
    expect(state.phase).toBe("idle");
    expect(state.activeTurnId).toBeNull();

    const afterTool = turnReducer(state, { type: "TOOL_USE_START" });
    expect(afterTool.phase).toBe("idle");
    expect(afterTool.activeToolCallCount).toBe(0);
  });

  test("TOOL_USE_START re-activates idle when activeTurnId is set", () => {
    const forcedIdle: TurnState = {
      phase: "idle",
      activeTurnId: "t-guard-4",
      activeToolCallCount: 0,
      pendingQueuedCount: 0,
      lastTerminalReason: null,
      statusText: null,
    };
    const afterTool = turnReducer(forcedIdle, { type: "TOOL_USE_START" });
    expect(afterTool.phase).toBe("thinking");
    expect(afterTool.activeToolCallCount).toBe(1);
  });

  test("POLL_RECONCILED → stale delta → new send works end-to-end", () => {
    // Simulates the full background/foreground race:
    // 1. Turn starts → streaming
    // 2. POLL_RECONCILED idles the turn (activeTurnId → null)
    // 3. Stale ASSISTANT_TEXT_DELTA arrives → should be ignored
    // 4. User sends new message → new turn starts cleanly
    let state = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-race-bg",
    });
    state = turnReducer(state, { type: "ASSISTANT_TEXT_DELTA" });
    expect(state.phase).toBe("streaming");

    state = turnReducer(state, {
      type: "POLL_RECONCILED",
      turnId: "t-race-bg",
    });
    expect(state.phase).toBe("idle");
    expect(state.activeTurnId).toBeNull();

    state = turnReducer(state, { type: "ASSISTANT_TEXT_DELTA" });
    expect(state.phase).toBe("idle");

    state = turnReducer(state, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-race-new",
    });
    expect(state.phase).toBe("thinking");
    expect(state.activeTurnId).toBe("t-race-new");
  });

  test("ASSISTANT_TEXT_DELTA still transitions thinking → streaming (no guard)", () => {
    let state = turnReducer(INITIAL_TURN_STATE, {
      type: "USER_SEND_REQUESTED",
      turnId: "t-thinking",
    });
    expect(state.phase).toBe("thinking");

    state = turnReducer(state, { type: "ASSISTANT_TEXT_DELTA" });
    expect(state.phase).toBe("streaming");
  });
});

// ---------------------------------------------------------------------------
// Envelope format parsing
// ---------------------------------------------------------------------------

describe("envelope format parsing", () => {
  test("parseAssistantEvent works the same regardless of envelope extraction", () => {
    // The envelope extraction happens in subscribeChatEvents before calling
    // parseAssistantEvent. Here we verify parseAssistantEvent handles the
    // extracted inner payload correctly.
    const innerPayload = {
      type: "assistant_text_delta",
      text: "Hello from envelope",
      messageId: "msg-env-1",
    };
    const event = parseAssistantEvent(innerPayload.type as string, innerPayload);
    expect(event).toEqual({
      type: "assistant_text_delta",
      text: "Hello from envelope",
      messageId: "msg-env-1",
    });
  });

  test("envelope extraction logic selects message.type over top-level type", () => {
    // Simulate the envelope extraction logic from subscribeChatEvents
    const envelopePayload: Record<string, unknown> = {
      type: "wrapper",
      message: {
        type: "assistant_text_delta",
        text: "nested",
        messageId: "msg-nested",
      },
    };

    // Replicate the extraction logic
    let eventData = envelopePayload;
    if (
      envelopePayload.message &&
      typeof envelopePayload.message === "object" &&
      !Array.isArray(envelopePayload.message) &&
      typeof (envelopePayload.message as Record<string, unknown>).type === "string"
    ) {
      eventData = envelopePayload.message as Record<string, unknown>;
    }

    const eventType = typeof eventData.type === "string" ? eventData.type : "message";
    const event = parseAssistantEvent(eventType, eventData);

    expect(event).toEqual({
      type: "assistant_text_delta",
      text: "nested",
      messageId: "msg-nested",
    });
  });

  test("envelope extraction supports sync_changed", () => {
    const envelopePayload: Record<string, unknown> = {
      type: "wrapper",
      message: {
        type: "sync_changed",
        tags: [SYNC_TAGS.assistantIdentity, "conversation:conversation-1:messages"],
      },
    };

    let eventData = envelopePayload;
    if (
      envelopePayload.message &&
      typeof envelopePayload.message === "object" &&
      !Array.isArray(envelopePayload.message) &&
      typeof (envelopePayload.message as Record<string, unknown>).type === "string"
    ) {
      eventData = envelopePayload.message as Record<string, unknown>;
    }

    const eventType = typeof eventData.type === "string" ? eventData.type : "message";
    const event = parseAssistantEvent(eventType, eventData);

    expect(event).toEqual({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantIdentity, "conversation:conversation-1:messages"],
    });
  });

  test("flat format still works when no message field is present", () => {
    const flatPayload: Record<string, unknown> = {
      type: "message_complete",
      messageId: "msg-flat",
      content: "flat content",
    };

    // Replicate the extraction logic
    let eventData = flatPayload;
    if (
      flatPayload.message &&
      typeof flatPayload.message === "object" &&
      !Array.isArray(flatPayload.message) &&
      typeof (flatPayload.message as Record<string, unknown>).type === "string"
    ) {
      eventData = flatPayload.message as Record<string, unknown>;
    }

    const eventType = typeof eventData.type === "string" ? eventData.type : "message";
    const event = parseAssistantEvent(eventType, eventData);

    expect(event).toEqual({
      type: "message_complete",
      messageId: "msg-flat",
      content: "flat content",
      attachments: undefined,
    });
  });

  test("flat sync_changed format works when no message field is present", () => {
    const flatPayload: Record<string, unknown> = {
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantSounds],
    };

    let eventData = flatPayload;
    if (
      flatPayload.message &&
      typeof flatPayload.message === "object" &&
      !Array.isArray(flatPayload.message) &&
      typeof (flatPayload.message as Record<string, unknown>).type === "string"
    ) {
      eventData = flatPayload.message as Record<string, unknown>;
    }

    const eventType = typeof eventData.type === "string" ? eventData.type : "message";
    const event = parseAssistantEvent(eventType, eventData);

    expect(event).toEqual({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantSounds],
    });
  });

  test("non-object message field is ignored (falls back to flat)", () => {
    const payload: Record<string, unknown> = {
      type: "error",
      message: "This is a string, not an envelope",
      code: "test_error",
    };

    let eventData = payload;
    if (
      payload.message &&
      typeof payload.message === "object" &&
      !Array.isArray(payload.message) &&
      typeof (payload.message as Record<string, unknown>).type === "string"
    ) {
      eventData = payload.message as Record<string, unknown>;
    }

    const eventType = typeof eventData.type === "string" ? eventData.type : "message";
    const event = parseAssistantEvent(eventType, eventData);

    expect(event).toEqual({
      type: "error",
      code: "test_error",
      message: "This is a string, not an envelope",
    });
  });
});

// ---------------------------------------------------------------------------
// RuntimeMessage metadata preservation
// ---------------------------------------------------------------------------

describe("RuntimeMessage metadata types", () => {
  test("RuntimeMessage interface accepts optional metadata fields", () => {
    // Type-level test: ensure RuntimeMessage can carry metadata
    const msg: import("./api").RuntimeMessage = {
      id: "msg-1",
      role: "assistant",
      content: "Hello",
      surfaces: [
        {
          surfaceId: "s-1",
          surfaceType: "card",
          data: { title: "Test" },
        },
      ],
      textSegments: [
        { type: "text", content: "Hello" },
      ],
      contentOrder: [
        { type: "text", id: "seg-1" },
        { type: "surface", id: "s-1" },
      ],
      metadata: { custom: true },
    };
    expect(msg.surfaces).toHaveLength(1);
    expect(msg.textSegments).toHaveLength(1);
    expect(msg.contentOrder).toHaveLength(2);
    expect(msg.metadata).toEqual({ custom: true });
  });

  test("RuntimeMessage works without metadata fields", () => {
    const msg: import("./api").RuntimeMessage = {
      id: "msg-2",
      role: "user",
      content: "Hi",
    };
    expect(msg.surfaces).toBeUndefined();
    expect(msg.textSegments).toBeUndefined();
    expect(msg.contentOrder).toBeUndefined();
    expect(msg.metadata).toBeUndefined();
  });

  test("ChatMessage interface accepts optional metadata fields", () => {
    const msg: import("./api").ChatMessage = {
      id: "msg-3",
      role: "assistant",
      content: "With metadata",
      surfaces: [{ surfaceId: "s-2", surfaceType: "form", data: {} }],
      textSegments: [{ type: "markdown", content: "# Header" }],
      contentOrder: [{ type: "surface", id: "s-2" }],
      metadata: { source: "test" },
    };
    expect(msg.surfaces).toHaveLength(1);
    expect(msg.metadata).toEqual({ source: "test" });
  });
});

describe("normalizeContentOrder", () => {
  test("converts string-format entries to objects", () => {
    const result = normalizeContentOrder(["text:0", "tool:1", "surface:2"]);
    expect(result).toEqual([
      { type: "text", id: "0" },
      { type: "tool", id: "1" },
      { type: "surface", id: "2" },
    ]);
  });

  test("passes through already-object entries unchanged", () => {
    const input = [
      { type: "text", id: "0" },
      { type: "toolCall", id: "abc-123" },
    ];
    const result = normalizeContentOrder(input);
    expect(result).toEqual(input);
  });

  test("handles mixed string and object entries", () => {
    const result = normalizeContentOrder([
      "text:0",
      { type: "toolCall", id: "tc-1" },
      "tool:1",
    ]);
    expect(result).toEqual([
      { type: "text", id: "0" },
      { type: "toolCall", id: "tc-1" },
      { type: "tool", id: "1" },
    ]);
  });

  test("handles thinking entries", () => {
    const result = normalizeContentOrder(["thinking:0", "text:0"]);
    expect(result).toEqual([
      { type: "thinking", id: "0" },
      { type: "text", id: "0" },
    ]);
  });

  test("returns undefined for empty or missing input", () => {
    expect(normalizeContentOrder(undefined)).toBeUndefined();
    expect(normalizeContentOrder([])).toBeUndefined();
  });

  test("skips malformed entries", () => {
    const result = normalizeContentOrder([
      "text:0",
      "nocolon",
      42 as unknown as string,
      null as unknown as string,
      { type: 123, id: "bad" } as unknown as { type: string; id: string },
      "tool:1",
    ]);
    expect(result).toEqual([
      { type: "text", id: "0" },
      { type: "tool", id: "1" },
    ]);
  });
});

describe("normalizeTextSegments", () => {
  test("converts plain strings to text segment objects", () => {
    const result = normalizeTextSegments(["Hello world", "Second segment"]);
    expect(result).toEqual([
      { type: "text", content: "Hello world" },
      { type: "text", content: "Second segment" },
    ]);
  });

  test("passes through already-object segments unchanged", () => {
    const input = [
      { type: "text", content: "Hello" },
      { type: "markdown", content: "# Header" },
    ];
    const result = normalizeTextSegments(input);
    expect(result).toEqual(input);
  });

  test("defaults type to text when object has content but no type", () => {
    const result = normalizeTextSegments([
      { content: "no type field" } as unknown as string,
    ]);
    expect(result).toEqual([{ type: "text", content: "no type field" }]);
  });

  test("handles mixed string and object entries", () => {
    const result = normalizeTextSegments([
      "plain string",
      { type: "text", content: "object form" },
    ]);
    expect(result).toEqual([
      { type: "text", content: "plain string" },
      { type: "text", content: "object form" },
    ]);
  });

  test("returns undefined for empty or missing input", () => {
    expect(normalizeTextSegments(undefined)).toBeUndefined();
    expect(normalizeTextSegments([])).toBeUndefined();
  });

  test("skips entries without content", () => {
    const result = normalizeTextSegments([
      "valid",
      { type: "text" } as unknown as string,
      42 as unknown as string,
      null as unknown as string,
    ]);
    expect(result).toEqual([{ type: "text", content: "valid" }]);
  });
});

describe("toDisplayAttachments", () => {
  test("returns undefined for empty/missing input", () => {
    expect(toDisplayAttachments(undefined)).toBeUndefined();
    expect(toDisplayAttachments([])).toBeUndefined();
  });

  test("converts image attachment with data-URI previewUrl", () => {
    const result = toDisplayAttachments([
      {
        id: "att-1",
        filename: "photo.png",
        mimeType: "image/png",
        data: "iVBORw0KGgo=",
      },
    ]);
    expect(result).toEqual([
      {
        id: "att-1",
        filename: "photo.png",
        mimeType: "image/png",
        sizeBytes: expect.any(Number),
        previewUrl: "data:image/png;base64,iVBORw0KGgo=",
      },
    ]);
  });

  test("creates data-URI previewUrl for non-image types with inline data", () => {
    const result = toDisplayAttachments([
      {
        id: "att-2",
        filename: "report.pdf",
        mimeType: "application/pdf",
        data: "JVBERi0xLjQ=",
      },
    ]);
    expect(result).toEqual([
      {
        id: "att-2",
        filename: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: expect.any(Number),
        previewUrl: "data:application/pdf;base64,JVBERi0xLjQ=",
      },
    ]);
  });

  test("uses thumbnailData when data is empty", () => {
    const result = toDisplayAttachments([
      {
        id: "att-3",
        filename: "clip.mp4",
        mimeType: "video/mp4",
        data: "",
        thumbnailData: "thumb123",
        fileBacked: true,
        sizeBytes: 1024,
      },
    ]);
    expect(result).toEqual([
      {
        id: "att-3",
        filename: "clip.mp4",
        mimeType: "video/mp4",
        sizeBytes: 1024,
        previewUrl: "data:image/jpeg;base64,thumb123",
      },
    ]);
  });

  test("falls back to filename for id when id is missing", () => {
    const result = toDisplayAttachments([
      {
        filename: "noId.txt",
        mimeType: "text/plain",
        data: "aGVsbG8=",
      },
    ]);
    expect(result?.[0]?.id).toBe("noId.txt");
  });
});

// ---------------------------------------------------------------------------
// postChatMessage onboarding wire payload
// ---------------------------------------------------------------------------

describe("postChatMessage onboarding payload", () => {
  let originalFetch: typeof fetch;
  let originalDocument: unknown;
  let capturedRequests: Array<{ url: string; body: string }> = [];

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    capturedRequests = [];
    // The vellum-api client request interceptor calls ensureCsrfCookie() on
    // mutating requests, which reads `document.cookie`. Stub a minimal
    // `document` so the bun test (Node) environment doesn't throw.
    originalDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { cookie: "csrftoken=test" };
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      // The heyapi client passes a Request object as `input`; read the body
      // by cloning and calling `.text()` so we can decode the JSON payload.
      const url = input instanceof Request ? input.url : String(input);
      let bodyText: string | undefined;
      if (input instanceof Request) {
        bodyText = await input.clone().text();
      } else if (typeof init?.body === "string") {
        bodyText = init.body;
      }
      capturedRequests.push({ url, body: bodyText ?? "" });
      if (url.includes("/workspace/file/")) {
        return new Response(JSON.stringify({ detail: "File not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/workspace/write/")) {
        return new Response(JSON.stringify({ path: "users/guardian.md", size: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({ accepted: true, messageId: "msg-1" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document?: unknown }).document = originalDocument;
    }
  });

  function getRequestBody(): Record<string, unknown> {
    const messageRequests = capturedRequests.filter((request) =>
      request.url.includes("/messages/"),
    );
    expect(messageRequests).toHaveLength(1);
    const rawBody = messageRequests[0]!.body;
    expect(rawBody.length).toBeGreaterThan(0);
    return JSON.parse(rawBody) as Record<string, unknown>;
  }

  function getWorkspaceWriteBodies(): Record<string, unknown>[] {
    return capturedRequests
      .filter((request) => request.url.includes("/workspace/write/"))
      .map((request) => JSON.parse(request.body) as Record<string, unknown>);
  }

  test("omits onboarding field when arg is undefined", async () => {
    const result = await postChatMessage("asst-1", "K", "hello");
    expect(result.ok).toBe(true);

    expect(capturedRequests).toHaveLength(1);
    const body = getRequestBody();
    expect(body).not.toHaveProperty("onboarding");
    expect(body.conversationKey).toBe("K");
    expect(body.content).toBe("hello");
  });

  test("includes normalized onboarding and seeds profile files before posting the message", async () => {
    await postChatMessage("asst-1", "K", "hello", [], {
      tools: ["github", "linear"],
      tasks: ["code-building", "writing"],
      tone: "friendly",
      userName: "Ada",
      assistantName: "Vel",
    });

    expect(capturedRequests.at(-1)?.url).toContain("/messages/");
    const body = getRequestBody();
    expect(body.onboarding).toEqual({
      tools: ["GitHub", "Linear"],
      tasks: ["builds code, apps, or tools", "writes docs, emails, or content"],
      tone: "friendly",
      userName: "Ada",
      assistantName: "Vel",
    });

    const writes = getWorkspaceWriteBodies();
    expect(writes.map((write) => write.path).sort()).toEqual([
      "users/default.md",
      "users/guardian.md",
    ]);
    for (const write of writes) {
      expect(write.content).toContain("## Onboarding Context");
      expect(write.content).toContain("- **Preferred name:** Ada");
      expect(write.content).toContain(
        "- **Common work:** builds code, apps, or tools; writes docs, emails, or content",
      );
      expect(write.content).toContain("- **Daily tools:** GitHub, Linear");
    }
  });

  test("excludes userName when undefined (matches macOS `if let userName`)", async () => {
    await postChatMessage("asst-1", "K", "hello", [], {
      tools: ["github"],
      tasks: ["plan"],
      tone: "concise",
      // userName intentionally omitted
      assistantName: "Vel",
    });

    const body = getRequestBody();
    expect(body.onboarding).toEqual({
      tools: ["GitHub"],
      tasks: ["plan"],
      tone: "concise",
      assistantName: "Vel",
    });
    const onboarding = body.onboarding as Record<string, unknown>;
    expect(onboarding).not.toHaveProperty("userName");
  });

  test("preserves empty-string userName/assistantName on the wire (matches macOS `if let` non-nil semantics)", async () => {
    // Codex P2 regression guard: a caller that intentionally sends "" to
    // represent a blank-but-present name must reach the wire untouched —
    // truthy checks would silently drop these and diverge from macOS.
    await postChatMessage("asst-1", "K", "hello", [], {
      tools: ["github"],
      tasks: ["plan"],
      tone: "concise",
      userName: "",
      assistantName: "",
    });

    const body = getRequestBody();
    expect(body.onboarding).toEqual({
      tools: ["GitHub"],
      tasks: ["plan"],
      tone: "concise",
      userName: "",
      assistantName: "",
    });
  });

  test("includes empty tools/tasks arrays as valid wire payload", async () => {
    await postChatMessage("asst-1", "K", "hello", [], {
      tools: [],
      tasks: [],
      tone: "neutral",
    });

    const body = getRequestBody();
    expect(body.onboarding).toEqual({
      tools: [],
      tasks: [],
      tone: "neutral",
    });
    const onboarding = body.onboarding as Record<string, unknown>;
    expect(onboarding).not.toHaveProperty("userName");
    expect(onboarding).not.toHaveProperty("assistantName");
  });
});

describe("subscribeChatEvents idle watchdog", () => {
  let originalFetch: typeof fetch;
  let originalDocument: unknown;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // The vellum-api request interceptor reads document.cookie via
    // ensureCsrfCookie() on mutating requests; harmless for this GET
    // path but keeps the bun (Node) test env consistent.
    originalDocument = (globalThis as { document?: unknown }).document;
    (globalThis as { document?: unknown }).document = { cookie: "csrftoken=test" };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) {
      delete (globalThis as { document?: unknown }).document;
    } else {
      (globalThis as { document?: unknown }).document = originalDocument;
    }
  });

  test("omits conversationKey query when subscribing to all assistant events", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = mock(
      async (input: RequestInfo | URL) => {
        requestedUrls.push(input instanceof Request ? input.url : String(input));
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.close();
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    ) as unknown as typeof fetch;

    const stream = subscribeChatEvents(
      "asst-1",
      null,
      () => {},
      () => {},
      { idleTimeoutMs: 5_000, reconnectBaseDelayMs: 10_000 },
    );

    try {
      await new Promise((r) => setTimeout(r, 50));
      expect(requestedUrls).toHaveLength(1);
      expect(requestedUrls[0]).toContain("/v1/assistants/asst-1/events/");
      expect(requestedUrls[0]).not.toContain("conversationKey");
    } finally {
      stream.cancel();
    }
  });

  test("force-reconnects when the SSE stream stalls past the idle timeout", async () => {
    // When the SSE transport silently stalls (no bytes flowing) but
    // never raises an error, the for-await-of loop in
    // subscribeChatEvents blocks forever and any messages emitted
    // server-side never reach the UI. The watchdog must abort the
    // active fetch after idleTimeoutMs and let the existing reconnect
    // path open a fresh connection.
    let fetchCallCount = 0;
    const capturedSignals: AbortSignal[] = [];

    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCallCount++;
        const signal = input instanceof Request ? input.signal : init?.signal;
        if (signal) capturedSignals.push(signal);

        // A body that never produces any bytes — the watchdog is the
        // only thing that can break this stream out of its read.
        const body = new ReadableStream({
          start() {
            // Intentionally empty: never enqueue, never close.
          },
        });

        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    ) as unknown as typeof fetch;

    const onEvent = mock(() => {});
    const onError = mock(() => {});
    let reconnectCallbacks = 0;

    const stream = subscribeChatEvents(
      "asst-1",
      "conv-key",
      onEvent,
      onError,
      {
        // Short timings so the test runs in well under a second.
        idleTimeoutMs: 50,
        reconnectBaseDelayMs: 10,
        onReconnect: () => {
          reconnectCallbacks++;
        },
      },
    );

    try {
      // Allow: connect → stall → watchdog (~50ms) → reconnect delay
      // (~10ms) → second connect, with comfortable margin.
      await new Promise((r) => setTimeout(r, 250));

      // The watchdog must have aborted at least the first attempt and
      // forced the SDK to open a fresh fetch.
      expect(fetchCallCount).toBeGreaterThanOrEqual(2);
      expect(capturedSignals[0]?.aborted).toBe(true);

      // Reconnect path was actually exercised, so reconcileActive-
      // Conversation() (wired by callers as onReconnect) would fire.
      expect(reconnectCallbacks).toBeGreaterThanOrEqual(1);
    } finally {
      stream.cancel();
    }
  });

  test("does not arm the watchdog while a slow onReconnect callback is in flight", async () => {
    // client.sse.get returns a lazy async generator: the underlying
    // fetch only kicks off on the first iterator pull, and the
    // onReconnect callback (which performs an HTTP reconcile
    // roundtrip and can take longer than idleTimeoutMs in practice)
    // sits between the two. Arming the watchdog before onReconnect
    // resolves would charge that reconcile time against the timeout
    // and could abort the new attempt before any SSE traffic ever
    // started — burning the reconnect budget on a recoverable
    // connection.
    let fetchCallCount = 0;
    const signalAbortedAtFetchStart: boolean[] = [];

    globalThis.fetch = mock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        fetchCallCount++;
        const signal = input instanceof Request ? input.signal : init?.signal;
        signalAbortedAtFetchStart.push(signal?.aborted ?? false);

        return new Response(
          new ReadableStream({
            start() {
              // Stall — force the watchdog to fire and trigger reconnect.
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      },
    ) as unknown as typeof fetch;

    const stream = subscribeChatEvents(
      "asst-1",
      "conv-key",
      () => {},
      () => {},
      {
        idleTimeoutMs: 50,
        reconnectBaseDelayMs: 10,
        // Comfortably longer than idleTimeoutMs: simulates a slow
        // reconcileActiveConversation() round-trip.
        onReconnect: async () => {
          await new Promise((r) => setTimeout(r, 150));
        },
      },
    );

    try {
      // first connect → stall (~50ms) → reconnect delay (~10ms) →
      // slow onReconnect (~150ms) → second fetch starts.
      await new Promise((r) => setTimeout(r, 400));

      expect(fetchCallCount).toBeGreaterThanOrEqual(2);
      // The signal each attempt receives must not already be aborted
      // at the moment the SDK initiates its fetch — if it were, the
      // watchdog would have charged the onReconnect window against
      // its budget and aborted the attempt before the stream could
      // produce any traffic.
      expect(signalAbortedAtFetchStart[0]).toBe(false);
      expect(signalAbortedAtFetchStart[1]).toBe(false);
    } finally {
      stream.cancel();
    }
  });

  test("records sse_watchdog_fired with attempt + idleTimeoutMs when the stream stalls", async () => {
    // The deferred Layer 2/3 watchdog work hinges on field data
    // showing how often the watchdog actually fires in production.
    // The diagnostic must (a) be recorded before the abort cascade
    // tears down per-attempt state, and (b) carry enough context
    // (attempt counter + idleTimeoutMs) for downstream analysis to
    // distinguish first-attempt fires from reconnect-attempt fires.
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              // Stall — force the watchdog to fire.
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    ) as unknown as typeof fetch;

    const eventCountBefore = getChatDiagnosticsEvents().length;
    const breadcrumbsBefore = sentryBreadcrumbs.length;
    const captureMessagesBefore = sentryCaptureMessages.length;

    const sub = subscribeChatEvents(
      "asst-watchdog",
      "conv-watchdog",
      () => {},
      () => {},
      { idleTimeoutMs: 50, reconnectBaseDelayMs: 10 },
    );

    try {
      // Comfortably past the first watchdog fire (~50ms).
      await new Promise((r) => setTimeout(r, 200));

      const newEvents = getChatDiagnosticsEvents().slice(eventCountBefore);
      const fires = newEvents.filter(
        (event) => event.kind === "sse_watchdog_fired",
      );
      expect(fires.length).toBeGreaterThanOrEqual(1);
      const first = fires[0]!;
      expect(first.details).toMatchObject({
        assistantId: "asst-watchdog",
        conversationKey: "conv-watchdog",
        idleTimeoutMs: 50,
      });
      // The first watchdog fire happens on the very first connect
      // attempt, before any reconnect has incremented the counter.
      expect(first.details.attempt).toBe(0);
      // Centralized platform tag is injected by recordChatDiagnostic.
      expect(first.details.platform).toBe("web");

      // Sentry mirrors are how fleet data answers the L2/L3 question.
      // Without these, telemetry is gated on user-submitted support
      // bundles, which biases the sample toward broken-and-noisy.
      const newBreadcrumbs = sentryBreadcrumbs.slice(breadcrumbsBefore);
      const watchdogBreadcrumb = newBreadcrumbs.find(
        (crumb) =>
          crumb.category === "sse.watchdog" &&
          crumb.message === "watchdog_fired",
      );
      expect(watchdogBreadcrumb).toBeDefined();
      expect(watchdogBreadcrumb!.data).toMatchObject({
        assistantId: "asst-watchdog",
        idleTimeoutMs: 50,
      });
      const newCaptureMessages = sentryCaptureMessages.slice(
        captureMessagesBefore,
      );
      const watchdogCapture = newCaptureMessages.find(
        (call) => call.message === "sse_watchdog_fired",
      );
      expect(watchdogCapture).toBeDefined();
      // platform must be a tag (not just an extra) so the L2/L3
      // breakdown — Capacitor iOS vs web — is one Discover query
      // away. Sentry's auto-detected os.name does not distinguish
      // Capacitor iOS from Safari iOS.
      expect(watchdogCapture!.tags).toMatchObject({
        context: "sse_watchdog",
        platform: "web",
      });
      expect(watchdogCapture!.extra).toMatchObject({
        assistantId: "asst-watchdog",
        conversationKey: "conv-watchdog",
        idleTimeoutMs: 50,
      });
    } finally {
      sub.cancel();
    }
  });

  test("tags watchdog fires with wasTurnSending + liveness counters so user-harming vs benign stalls are aggregable", async () => {
    // The 100% bucket=0 reading on `sse_post_watchdog_reconcile_result`
    // collapses two populations into one: stalls during an in-flight
    // turn (user-harming — visible blank screen) and stalls on an
    // idle stream after a turn completed (benign — user is not
    // waiting on anything). Without splitting these, the Layer 2/3
    // decision is uninterpretable, because the L2/L3 work only
    // helps the first population.
    //
    // wasTurnSending is the dimension that splits them: promoted to a
    // tag so a single Discover groupBy answers "what fraction of
    // watchdog fires happen while the user is waiting?" The liveness
    // counters (keepalivesReceivedSinceConnect, dataFramesReceivedSinceConnect,
    // lastByteAgeMs) further split each population by whether vembda
    // was alive at the time of the stall, distinguishing
    // "vembda alive, daemon silent" from "server never responded"
    // from "stream died mid-turn".
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              // Stall — force the watchdog to fire.
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    ) as unknown as typeof fetch;

    const eventCountBefore = getChatDiagnosticsEvents().length;
    const captureMessagesBefore = sentryCaptureMessages.length;

    const sub = subscribeChatEvents(
      "asst-aggregation",
      "conv-aggregation",
      () => {},
      () => {},
      {
        idleTimeoutMs: 50,
        reconnectBaseDelayMs: 10,
        // Caller supplies a synchronous snapshot of turn state at
        // watchdog-fire time. Returning true here models a stall
        // during an in-flight turn — the user-harming case.
        getActiveTurnSending: () => true,
      },
    );

    try {
      await new Promise((r) => setTimeout(r, 200));

      const newEvents = getChatDiagnosticsEvents().slice(eventCountBefore);
      const firstFire = newEvents.find(
        (event) => event.kind === "sse_watchdog_fired",
      );
      expect(firstFire).toBeDefined();
      // The diagnostic carries the same fields as the Sentry extras
      // so support snapshots (which only ship the diagnostics
      // buffer, not Sentry events) can answer the same questions.
      expect(firstFire!.details).toMatchObject({
        wasTurnSending: true,
        // No SSE traffic arrived because the stream stalled on
        // first byte, so the counters stay at zero and
        // lastByteAgeMs stays null (distinguishes
        // "server never responded" from "stream stalled after
        // some traffic").
        keepalivesReceivedSinceConnect: 0,
        dataFramesReceivedSinceConnect: 0,
        lastByteAgeMs: null,
      });

      const newCaptureMessages = sentryCaptureMessages.slice(
        captureMessagesBefore,
      );
      const watchdogCapture = newCaptureMessages.find(
        (call) => call.message === "sse_watchdog_fired",
      );
      expect(watchdogCapture).toBeDefined();
      // wasTurnSending is promoted to a TAG (not just extra) so
      // Discover can groupBy it. String-encoded because Sentry
      // tag values must be strings.
      expect(watchdogCapture!.tags).toMatchObject({
        context: "sse_watchdog",
        wasTurnSending: "true",
      });
      // And mirrored as an extra so per-event drill-in shows the
      // raw boolean alongside the counters.
      expect(watchdogCapture!.extra).toMatchObject({
        wasTurnSending: true,
        keepalivesReceivedSinceConnect: 0,
        dataFramesReceivedSinceConnect: 0,
        lastByteAgeMs: null,
      });
    } finally {
      sub.cancel();
    }
  });

  test("tags wasTurnSending: 'unknown' when no getActiveTurnSending snapshot is supplied", async () => {
    // Backwards compatibility: callers that have not yet wired the
    // turn-sending snapshot (e.g. unit tests of subscribeChatEvents
    // in isolation, or any caller pre-LUM-1538) must still produce
    // a tag value, not omit the field. Sentry groups absent tags as
    // `"<no-tag>"` in Discover, which collides with healthy events
    // that legitimately have no value. Sending `"unknown"` makes
    // the missing-instrumentation population explicit.
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              // Stall.
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    ) as unknown as typeof fetch;

    const captureMessagesBefore = sentryCaptureMessages.length;

    const sub = subscribeChatEvents(
      "asst-no-snapshot",
      "conv-no-snapshot",
      () => {},
      () => {},
      { idleTimeoutMs: 50, reconnectBaseDelayMs: 10 },
    );

    try {
      await new Promise((r) => setTimeout(r, 200));

      const newCaptureMessages = sentryCaptureMessages.slice(
        captureMessagesBefore,
      );
      const watchdogCapture = newCaptureMessages.find(
        (call) => call.message === "sse_watchdog_fired",
      );
      expect(watchdogCapture).toBeDefined();
      expect(watchdogCapture!.tags).toMatchObject({
        wasTurnSending: "unknown",
      });
      // Extra remains the raw `null` so per-event drill-in
      // distinguishes "caller didn't provide" from "caller
      // provided false".
      expect(watchdogCapture!.extra).toMatchObject({
        wasTurnSending: null,
      });
    } finally {
      sub.cancel();
    }
  });

  test("counts heartbeat comment frames and data frames separately so vembda-alive vs server-silent stalls are distinguishable", async () => {
    // Comment frames (vembda's `: keepalive\n\n` heartbeats and the
    // daemon's own heartbeats) reset the watchdog but never yield
    // through the for-await iterator. Counting them separately
    // from data frames lets the diagnostic distinguish three
    // failure modes at the moment of a stall:
    //
    //   - keepalives > 0, dataFrames = 0 → vembda alive, daemon silent
    //     (the daemon stopped emitting tokens but the vembda
    //     keepalive injector is still running)
    //   - keepalives = 0, dataFrames > 0 → stream died mid-turn
    //     (data was flowing but suddenly stopped with no keepalive
    //     before the timeout)
    //   - keepalives = 0, dataFrames = 0 → server never responded
    //     (no traffic at all on this attempt)
    //
    // Each of these maps to a different fix. Without splitting the
    // counters, the watchdog fire is uninterpretable.
    const encoder = new TextEncoder();
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            async start(controller) {
              // Two heartbeat comment frames (no data:line) and one
              // data frame, then stall.
              controller.enqueue(encoder.encode(": keepalive\n\n"));
              await new Promise((r) => setTimeout(r, 10));
              controller.enqueue(encoder.encode(": keepalive\n\n"));
              await new Promise((r) => setTimeout(r, 10));
              controller.enqueue(
                encoder.encode('event: token\ndata: "hello"\n\n'),
              );
              // Now stall — let the watchdog fire.
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    ) as unknown as typeof fetch;

    const eventCountBefore = getChatDiagnosticsEvents().length;

    const sub = subscribeChatEvents(
      "asst-heartbeat",
      "conv-heartbeat",
      () => {},
      () => {},
      { idleTimeoutMs: 100, reconnectBaseDelayMs: 10 },
    );

    try {
      // First fire happens after the data frame at ~20ms +
      // idleTimeoutMs = ~120ms. 250ms gives comfortable margin.
      await new Promise((r) => setTimeout(r, 250));

      const newEvents = getChatDiagnosticsEvents().slice(eventCountBefore);
      const firstFire = newEvents.find(
        (event) => event.kind === "sse_watchdog_fired",
      );
      expect(firstFire).toBeDefined();
      // Two heartbeat comment frames and one data frame arrived
      // before the stall.
      expect(firstFire!.details.keepalivesReceivedSinceConnect).toBe(2);
      expect(firstFire!.details.dataFramesReceivedSinceConnect).toBe(1);
      // lastByteAgeMs is the time since the last SSE chunk; with
      // idleTimeoutMs=100 the watchdog fires ~100ms after the
      // last chunk, so the age should be in the 100-200ms range.
      // Don't pin a tight bound (the test runner's clock has
      // resolution >1ms); just assert it is a positive number,
      // not null (which would mean "no traffic at all").
      expect(typeof firstFire!.details.lastByteAgeMs).toBe("number");
      expect(firstFire!.details.lastByteAgeMs as number).toBeGreaterThanOrEqual(
        90,
      );
    } finally {
      sub.cancel();
    }
  });

  test("threads cause: 'watchdog' to onReconnect after the watchdog aborts a stall", async () => {
    // Distinguishing watchdog-driven reconnects from ordinary
    // transport-error reconnects is what makes the post-reconnect
    // reconcile_result diagnostic interpretable: a "messages
    // recovered" signal is only meaningful when scoped to the
    // silent-stall recovery path.
    globalThis.fetch = mock(
      async () =>
        new Response(
          new ReadableStream({
            start() {
              // Stall — force the watchdog to fire.
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
    ) as unknown as typeof fetch;

    const causes: ChatStreamReconnectCause[] = [];

    const sub = subscribeChatEvents(
      "asst-1",
      "conv-key",
      () => {},
      () => {},
      {
        idleTimeoutMs: 50,
        reconnectBaseDelayMs: 10,
        onReconnect: (cause) => {
          causes.push(cause);
        },
      },
    );

    try {
      // first connect → stall (~50ms) → reconnect delay (~10ms) →
      // onReconnect invoked, with comfortable margin.
      await new Promise((r) => setTimeout(r, 250));

      expect(causes.length).toBeGreaterThanOrEqual(1);
      // Every reconnect in this scenario is watchdog-driven because
      // the stalling fetch never produces an SDK-surfaced error.
      for (const cause of causes) {
        expect(cause).toBe("watchdog");
      }
    } finally {
      sub.cancel();
    }
  });

  test("does not falsely tag a transport error as watchdog-driven when the timer would fire mid-backoff", async () => {
    // Regression for the stale-timer hazard: armWatchdog runs a
    // setTimeout that survives the for-await loop's exit, so a
    // transport error close to the idle deadline can leave the
    // timer armed during the reconnect backoff. If the timer then
    // fires before the next connect attempt, the new diagnostic
    // path would set lastAbortCause = "watchdog" and tag a
    // recoverable error path as a watchdog stall in telemetry.
    // Verifies that clearing the watchdog when the for-await loop
    // exits prevents that false attribution.
    // Every attempt errors after ~50ms — earlier than the 100ms
    // idle deadline — so the watchdog should never legitimately
    // fire under test. With the fix in place, the timer is cleared
    // when the for-await loop exits, before the reconnect backoff
    // window opens; without it, the timer would fire mid-backoff
    // and false-tag the next reconnect as watchdog-driven.
    let fetchCallCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      const localCount = fetchCallCount;
      return new Response(
        new ReadableStream({
          start(controller) {
            setTimeout(() => {
              controller.error(
                new Error(`transport failure ${localCount}`),
              );
            }, 50);
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const causes: ChatStreamReconnectCause[] = [];
    const eventCountBefore = getChatDiagnosticsEvents().length;

    const sub = subscribeChatEvents(
      "asst-stale",
      "conv-stale",
      () => {},
      () => {},
      {
        // Tight idle window + longer backoff: the original idle
        // timer's deadline (100ms) lands inside the reconnect
        // backoff window (200ms), so a stale fire would be
        // observable as a "watchdog" cause on the next attempt.
        idleTimeoutMs: 100,
        reconnectBaseDelayMs: 200,
        onReconnect: (cause) => {
          causes.push(cause);
        },
      },
    );

    try {
      // First fetch errors (~50ms) → reconnect awaits 200ms →
      // second connect runs at ~250ms (also errors at ~50ms in).
      // 400ms gives a clean window with exactly one onReconnect
      // call observable and no watchdog opportunity on attempt 2.
      await new Promise((r) => setTimeout(r, 400));

      expect(causes.length).toBeGreaterThanOrEqual(1);
      expect(causes[0]).toBe("error");

      // No sse_watchdog_fired diagnostic should have been recorded
      // for this subscription — every fetch errored before its
      // watchdog deadline, so any fire is from a stale timer.
      const newEvents = getChatDiagnosticsEvents().slice(eventCountBefore);
      const fires = newEvents.filter(
        (event) =>
          event.kind === "sse_watchdog_fired" &&
          (event.details as { assistantId?: unknown }).assistantId ===
            "asst-stale",
      );
      expect(fires.length).toBe(0);
    } finally {
      sub.cancel();
    }
  });

  test("threads cause: 'error' to onReconnect when the stream surfaces a transport error", async () => {
    // Symmetric counterpart to the watchdog-cause test: when the SDK
    // raises an error on the iterator (a real transport failure, not
    // a silent stall), the reconnect path must report `cause:
    // "error"` so callers don't tag the post-reconnect reconcile as
    // a watchdog-recovery in their telemetry.
    let fetchCallCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        // First attempt: body errors out shortly after open. The SDK
        // surfaces this via onSseError, which ends the iterator and
        // sends connect() down its reconnect branch with no watchdog
        // involvement.
        return new Response(
          new ReadableStream({
            start(controller) {
              setTimeout(() => {
                controller.error(new Error("transport failure"));
              }, 10);
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      // Subsequent attempts stall so we can cancel cleanly without
      // the test cascading through more reconnect rounds.
      return new Response(
        new ReadableStream({
          start() {},
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      );
    }) as unknown as typeof fetch;

    const causes: ChatStreamReconnectCause[] = [];

    const sub = subscribeChatEvents(
      "asst-1",
      "conv-key",
      () => {},
      () => {},
      {
        // Generous idle timeout: must comfortably exceed the
        // ~10ms transport error + ~10ms reconnect delay + the
        // measurement window below, so the watchdog cannot race
        // the error path and contaminate the recorded cause.
        idleTimeoutMs: 5000,
        reconnectBaseDelayMs: 10,
        onReconnect: (cause) => {
          causes.push(cause);
        },
      },
    );

    try {
      await new Promise((r) => setTimeout(r, 200));

      expect(causes.length).toBeGreaterThanOrEqual(1);
      expect(causes[0]).toBe("error");
    } finally {
      sub.cancel();
    }
  });

  test("cancel() halts further reconnects after the watchdog fires", async () => {
    // The watchdog must not survive cancel(): otherwise a stalled
    // stream that the caller has already torn down would keep
    // hammering the daemon with reconnect attempts.
    let fetchCallCount = 0;

    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      return new Response(
        new ReadableStream({
          start() {
            // Never produce bytes — force the watchdog to fire.
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        },
      );
    }) as unknown as typeof fetch;

    const sub = subscribeChatEvents(
      "asst-1",
      "conv-key",
      () => {},
      () => {},
      { idleTimeoutMs: 50, reconnectBaseDelayMs: 10 },
    );

    // Wait long enough for at least one watchdog fire + reconnect.
    await new Promise((r) => setTimeout(r, 200));
    sub.cancel();
    const countAtCancel = fetchCallCount;

    // After cancel, no further attempts should be scheduled.
    await new Promise((r) => setTimeout(r, 250));
    expect(fetchCallCount).toBe(countAtCancel);
  });
});

// ---------------------------------------------------------------------------
// recordChatDiagnostic — centralized platform tag injection
// ---------------------------------------------------------------------------
//
// The L2/L3 watchdog decision is platform-conditioned: LUM-1431 was
// iOS-only, so a platform breakdown of watchdog fires is the data we
// actually need. The diagnostics module injects `platform` once at the
// SDK boundary (per the OpenTelemetry resource-attribute convention
// — https://opentelemetry.io/docs/specs/otel/resource/sdk/) so every
// caller gets it for free without per-call-site plumbing. These tests
// pin that contract and exercise the happy path under the mocked
// Capacitor module rather than the diagnostics module's defensive
// fallback.

describe("recordChatDiagnostic platform tag", () => {
  test("injects platform from Capacitor.getPlatform on every recorded event", () => {
    mockedPlatform = "ios";
    const eventCountBefore = getChatDiagnosticsEvents().length;

    recordChatDiagnostic("test_kind_a", { foo: "bar" });
    recordChatDiagnostic("test_kind_b", { baz: 1 });

    const newEvents = getChatDiagnosticsEvents().slice(eventCountBefore);
    expect(newEvents).toHaveLength(2);
    expect(newEvents[0]!.kind).toBe("test_kind_a");
    expect(newEvents[0]!.details.platform).toBe("ios");
    expect(newEvents[0]!.details.foo).toBe("bar");
    expect(newEvents[1]!.kind).toBe("test_kind_b");
    expect(newEvents[1]!.details.platform).toBe("ios");
    expect(newEvents[1]!.details.baz).toBe(1);

    mockedPlatform = "web";
  });

  test("call-site keys win over the injected platform tag", () => {
    // Future code may legitimately need to override the resolved
    // platform (cross-surface event forwarding, replay tooling).
    // Spread order in recordChatDiagnostic makes call-site keys
    // win on collision; this test pins that ordering.
    const eventCountBefore = getChatDiagnosticsEvents().length;

    recordChatDiagnostic("test_kind_override", {
      platform: "explicit-override",
    });

    const newEvents = getChatDiagnosticsEvents().slice(eventCountBefore);
    expect(newEvents).toHaveLength(1);
    expect(newEvents[0]!.details.platform).toBe("explicit-override");
  });

  test("injects different platform values when Capacitor reports different surfaces", () => {
    const eventCountBefore = getChatDiagnosticsEvents().length;

    mockedPlatform = "android";
    recordChatDiagnostic("test_kind_android");
    mockedPlatform = "web";
    recordChatDiagnostic("test_kind_web");

    const newEvents = getChatDiagnosticsEvents().slice(eventCountBefore);
    expect(newEvents).toHaveLength(2);
    expect(newEvents[0]!.details.platform).toBe("android");
    expect(newEvents[1]!.details.platform).toBe("web");
  });
});

describe("parseConversation — originChannel plumbing", () => {
  test("returns null for non-object input", () => {
    expect(parseConversation(null)).toBeNull();
    expect(parseConversation(undefined)).toBeNull();
    expect(parseConversation("string")).toBeNull();
  });

  test("returns null when no conversationKey/id is present", () => {
    expect(parseConversation({})).toBeNull();
  });

  test("leaves originChannel undefined when neither field is present", () => {
    const parsed = parseConversation({
      conversationKey: "conv-123",
      title: "Hello",
    });
    expect(parsed?.originChannel).toBeUndefined();
  });

  test("reads originChannel from conversationOriginChannel as a fallback", () => {
    const parsed = parseConversation({
      conversationKey: "conv-123",
      conversationOriginChannel: "slack",
    });
    expect(parsed?.originChannel).toBe("slack");
  });

  test("prefers channelBinding.sourceChannel over conversationOriginChannel", () => {
    const parsed = parseConversation({
      conversationKey: "conv-123",
      channelBinding: { sourceChannel: "telegram" },
      conversationOriginChannel: "slack",
    });
    expect(parsed?.originChannel).toBe("telegram");
  });

  test("treats non-string channelBinding.sourceChannel as missing", () => {
    const parsed = parseConversation({
      conversationKey: "conv-123",
      channelBinding: { sourceChannel: 42 },
      conversationOriginChannel: "slack",
    });
    expect(parsed?.originChannel).toBe("slack");
  });

  test("treats notification:* origin channel as a literal pass-through", () => {
    // `isChannelConversation` is the layer that excludes notification:*;
    // the parser must preserve the raw value as-is so the predicate can
    // make the decision.
    const parsed = parseConversation({
      conversationKey: "conv-123",
      conversationOriginChannel: "notification:reminder",
    });
    expect(parsed?.originChannel).toBe("notification:reminder");
  });
});
