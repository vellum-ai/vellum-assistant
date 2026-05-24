import { describe, expect, test } from "bun:test";

import { parseAssistantEvent, toDisplayAttachments } from "@/domains/chat/api/event-parser.js";
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

  test("preserves message_complete conversationId", () => {
    const event = parseAssistantEvent("message_complete", {
      messageId: "msg-1",
      content: "Full response",
      conversationId: "conversation-1",
    });
    expect(event).toEqual({
      type: "message_complete",
      messageId: "msg-1",
      content: "Full response",
      attachments: undefined,
      conversationId: "conversation-1",
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

  test("parses interaction_resolved with explicit conversationId", () => {
    const event = parseAssistantEvent("interaction_resolved", {
      requestId: "req-1",
      conversationId: "conv-1",
      state: "approved",
      kind: "confirmation",
    });
    expect(event).toEqual({
      type: "interaction_resolved",
      requestId: "req-1",
      conversationId: "conv-1",
      state: "approved",
      kind: "confirmation",
    });
  });

  test("interaction_resolved with an invalid state degrades to unknown", () => {
    const event = parseAssistantEvent("interaction_resolved", {
      requestId: "req-3",
      conversationId: "conv-3",
      state: "exploded",
      kind: "confirmation",
    });
    expect(event.type).toBe("unknown");
  });

  test("interaction_resolved without a requestId degrades to unknown", () => {
    const event = parseAssistantEvent("interaction_resolved", {
      conversationId: "conv-4",
      state: "cancelled",
    });
    expect(event.type).toBe("unknown");
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

  test("parses sync_changed with originClientId", () => {
    const event = parseAssistantEvent("sync_changed", {
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: "client-abc",
    });
    expect(event).toEqual({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: "client-abc",
    });
  });

  test("omits originClientId from sync_changed when absent", () => {
    const event = parseAssistantEvent("sync_changed", {
      tags: [SYNC_TAGS.assistantAvatar],
    });
    expect(event).toEqual({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
    });
    expect("originClientId" in event).toBe(false);
  });

  test("ignores blank or non-string originClientId on sync_changed", () => {
    const blank = parseAssistantEvent("sync_changed", {
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: "   ",
    });
    expect("originClientId" in blank).toBe(false);

    const nonString = parseAssistantEvent("sync_changed", {
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: 42,
    });
    expect("originClientId" in nonString).toBe(false);

    const trimmed = parseAssistantEvent("sync_changed", {
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: "  client-xyz  ",
    });
    expect(trimmed).toEqual({
      type: "sync_changed",
      tags: [SYNC_TAGS.assistantAvatar],
      originClientId: "client-xyz",
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
      conversationId: "conv-1",
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
      conversationId: "conv-1",
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
      conversationId: "conv-1",
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
      conversationId: "conv-1",
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
      conversationId: "conv-1",
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
      conversationId: undefined,
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
      conversationId: "conversation-123",
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
      conversationId: "conversation-123",
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
      conversationId: undefined,
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
    const msg: import("./messages.js").RuntimeMessage = {
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
    const msg: import("./messages.js").RuntimeMessage = {
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
    const msg: import("./event-types.js").ChatMessage = {
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
