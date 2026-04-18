/**
 * Regression tests locking the exact payload shapes emitted by the
 * standalone surface lifecycle (showStandaloneSurface + handleSurfaceAction).
 *
 * These tests verify that daemon-driven standalone surfaces (not LLM tool
 * invocations) produce wire messages matching the contracts that macOS/iOS/web
 * clients decode. Any payload shape drift here is a client compatibility break.
 *
 * Surface lifecycle under test:
 *   1. `ui_surface_show`    — daemon → client  (showStandaloneSurface)
 *   2. `ui_surface_action`  — client → daemon  (user click)
 *   3. `ui_surface_complete` — daemon → client (handleSurfaceAction resolving standalone)
 *
 * The Swift client decodes these via:
 *   - UiSurfaceShowMessage     (MessageTypes.swift)
 *   - UiSurfaceCompleteMessage (MessageTypes.swift)
 * and dispatches them in ChatActionHandler → ChatViewModel+SurfaceHandling.
 */

import { describe, expect, test } from "bun:test";

import {
  buildCompletionSummary,
  handleSurfaceAction,
  showStandaloneSurface,
  type SurfaceConversationContext,
} from "../daemon/conversation-surfaces.js";
import type { ServerMessage } from "../daemon/message-protocol.js";

// ── Helpers ──────────────────────────────────────────────────────────

function createMockContext(
  overrides?: Partial<{
    hasNoClient: boolean;
    supportsDynamicUi: boolean;
    channel: string;
  }>,
): SurfaceConversationContext & {
  sentMessages: ServerMessage[];
  enqueuedMessages: Array<{ content: string; requestId: string }>;
} {
  const sentMessages: ServerMessage[] = [];
  const enqueuedMessages: Array<{ content: string; requestId: string }> = [];

  return {
    conversationId: "payload-test-conv",
    assistantId: undefined,
    trustContext: undefined,
    channelCapabilities: overrides?.channel
      ? {
          channel: overrides.channel,
          supportsDynamicUi: overrides.supportsDynamicUi ?? true,
        }
      : undefined,
    traceEmitter: { emit: () => {} },
    sendToClient: (msg: ServerMessage) => sentMessages.push(msg),
    broadcastToAllClients: (msg: ServerMessage) => sentMessages.push(msg),
    pendingSurfaceActions: new Map(),
    lastSurfaceAction: new Map(),
    surfaceState: new Map(),
    surfaceUndoStacks: new Map(),
    accumulatedSurfaceState: new Map(),
    surfaceActionRequestIds: new Set(),
    pendingStandaloneSurfaces: new Map(),
    currentTurnSurfaces: [],
    hostCuProxy: undefined,
    hasNoClient: overrides?.hasNoClient ?? false,
    isProcessing: () => false,
    enqueueMessage: (content, _attachments, _onEvent, requestId) => {
      enqueuedMessages.push({ content, requestId });
      return { queued: false, requestId };
    },
    getQueueDepth: () => 0,
    processMessage: async () => "msg-id",
    withSurface: async <T>(_surfaceId: string, fn: () => T | Promise<T>) =>
      fn(),
    sentMessages,
    enqueuedMessages,
  };
}

type AnyRecord = Record<string, unknown>;

function findByType(
  messages: ServerMessage[],
  type: string,
): AnyRecord | undefined {
  return messages.find(
    (m) => (m as unknown as AnyRecord).type === type,
  ) as unknown as AnyRecord | undefined;
}

function findAllByType(messages: ServerMessage[], type: string): AnyRecord[] {
  return messages.filter(
    (m) => (m as unknown as AnyRecord).type === type,
  ) as unknown as AnyRecord[];
}

// ── Confirmation surface payload shapes ──────────────────────────────

describe("standalone confirmation surface payload shapes", () => {
  test("ui_surface_show payload matches UiSurfaceShowMessage contract", async () => {
    const ctx = createMockContext();

    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "payload-test-conv",
        surfaceType: "confirmation",
        title: "Delete project?",
        data: {
          message: "This will permanently delete the project and all data.",
          detail: "This action cannot be undone.",
          confirmLabel: "Delete",
          cancelLabel: "Keep",
          destructive: true,
        },
        actions: [
          { id: "confirm", label: "Delete", variant: "danger" },
          { id: "cancel", label: "Keep", variant: "secondary" },
        ],
        timeoutMs: 60_000,
      },
      "payload-surf-1",
    );

    const showMsg = findByType(ctx.sentMessages, "ui_surface_show");
    expect(showMsg).toBeDefined();

    // ── Fields the Swift UiSurfaceShowMessage struct decodes ──
    // These are the exact keys the client expects. Missing or renamed
    // keys will cause a decoding failure on the client.
    expect(showMsg!.type).toBe("ui_surface_show");
    expect(showMsg!.conversationId).toBe("payload-test-conv");
    expect(showMsg!.surfaceId).toBe("payload-surf-1");
    expect(showMsg!.surfaceType).toBe("confirmation");
    expect(showMsg!.title).toBe("Delete project?");
    expect(showMsg!.display).toBe("inline");

    // ── data field: ConfirmationSurfaceData ──
    const data = showMsg!.data as AnyRecord;
    expect(data.message).toBe(
      "This will permanently delete the project and all data.",
    );
    expect(data.detail).toBe("This action cannot be undone.");
    expect(data.confirmLabel).toBe("Delete");
    expect(data.cancelLabel).toBe("Keep");
    expect(data.destructive).toBe(true);

    // ── actions array: SurfaceAction[] ──
    const actions = showMsg!.actions as Array<AnyRecord>;
    expect(actions).toHaveLength(2);
    expect(actions[0].id).toBe("confirm");
    expect(actions[0].label).toBe("Delete");
    expect(actions[0].style).toBe("destructive"); // "danger" maps to "destructive"
    expect(actions[1].id).toBe("cancel");
    expect(actions[1].label).toBe("Keep");
    expect(actions[1].style).toBe("secondary");

    // Resolve to avoid dangling timer
    await handleSurfaceAction(ctx, "payload-surf-1", "confirm");
    await resultPromise;
  });

  test("ui_surface_complete payload on confirm matches UiSurfaceCompleteMessage contract", async () => {
    const ctx = createMockContext();

    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "payload-test-conv",
        surfaceType: "confirmation",
        data: {
          message: "Proceed with deployment?",
          confirmLabel: "Deploy",
          cancelLabel: "Abort",
        },
        timeoutMs: 60_000,
      },
      "payload-surf-2",
    );

    // Clear show messages
    ctx.sentMessages.length = 0;

    // Simulate user clicking confirm with submitted data
    await handleSurfaceAction(ctx, "payload-surf-2", "confirm", {
      environment: "production",
    });
    await resultPromise;

    const completeMsg = findByType(ctx.sentMessages, "ui_surface_complete");
    expect(completeMsg).toBeDefined();

    // ── Fields the Swift UiSurfaceCompleteMessage struct decodes ──
    expect(completeMsg!.type).toBe("ui_surface_complete");
    expect(completeMsg!.conversationId).toBe("payload-test-conv");
    expect(completeMsg!.surfaceId).toBe("payload-surf-2");
    expect(typeof completeMsg!.summary).toBe("string");
    expect(completeMsg!.summary).toBe('User chose: "Deploy"');
    // submittedData should contain the action data from the user click
    expect(completeMsg!.submittedData).toEqual({ environment: "production" });
  });

  test("ui_surface_complete payload on cancel matches UiSurfaceCompleteMessage contract", async () => {
    const ctx = createMockContext();

    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "payload-test-conv",
        surfaceType: "confirmation",
        data: {
          message: "Discard changes?",
          cancelLabel: "Keep editing",
        },
        timeoutMs: 60_000,
      },
      "payload-surf-3",
    );

    ctx.sentMessages.length = 0;

    await handleSurfaceAction(ctx, "payload-surf-3", "cancel");
    await resultPromise;

    const completeMsg = findByType(ctx.sentMessages, "ui_surface_complete");
    expect(completeMsg).toBeDefined();

    expect(completeMsg!.type).toBe("ui_surface_complete");
    expect(completeMsg!.conversationId).toBe("payload-test-conv");
    expect(completeMsg!.surfaceId).toBe("payload-surf-3");
    expect(completeMsg!.summary).toBe('User chose: "Keep editing"');
    // No submittedData on cancel without explicit data
    expect(completeMsg!.submittedData).toBeUndefined();
  });

  test("ui_surface_complete on timeout matches UiSurfaceCompleteMessage contract", async () => {
    const ctx = createMockContext();

    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "payload-test-conv",
        surfaceType: "confirmation",
        data: { message: "Quick confirm" },
        timeoutMs: 50,
      },
      "payload-surf-4",
    );

    await resultPromise;

    const completeMsg = findByType(ctx.sentMessages, "ui_surface_complete");
    expect(completeMsg).toBeDefined();

    expect(completeMsg!.type).toBe("ui_surface_complete");
    expect(completeMsg!.conversationId).toBe("payload-test-conv");
    expect(completeMsg!.surfaceId).toBe("payload-surf-4");
    expect(completeMsg!.summary).toBe("Timed out");
    // No submittedData on timeout
    expect(completeMsg!).not.toHaveProperty("submittedData");
  });
});

// ── Form surface payload shapes ──────────────────────────────────────

describe("standalone form surface payload shapes", () => {
  test("ui_surface_show payload for form matches UiSurfaceShowMessage contract", async () => {
    const ctx = createMockContext();

    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "payload-test-conv",
        surfaceType: "form",
        title: "Configure settings",
        data: {
          description: "Adjust your preferences below.",
          fields: [
            {
              id: "name",
              type: "text",
              label: "Display Name",
              placeholder: "Enter your name",
              required: true,
            },
            {
              id: "theme",
              type: "select",
              label: "Theme",
              options: [
                { label: "Light", value: "light" },
                { label: "Dark", value: "dark" },
              ],
              defaultValue: "dark",
            },
            {
              id: "notifications",
              type: "toggle",
              label: "Enable notifications",
              defaultValue: true,
            },
          ],
          submitLabel: "Save",
        },
        timeoutMs: 60_000,
      },
      "payload-surf-form-1",
    );

    const showMsg = findByType(ctx.sentMessages, "ui_surface_show");
    expect(showMsg).toBeDefined();

    // ── Core wire fields ──
    expect(showMsg!.type).toBe("ui_surface_show");
    expect(showMsg!.conversationId).toBe("payload-test-conv");
    expect(showMsg!.surfaceId).toBe("payload-surf-form-1");
    expect(showMsg!.surfaceType).toBe("form");
    expect(showMsg!.title).toBe("Configure settings");
    expect(showMsg!.display).toBe("inline");

    // ── data field: FormSurfaceData ──
    const data = showMsg!.data as AnyRecord;
    expect(data.description).toBe("Adjust your preferences below.");
    expect(data.submitLabel).toBe("Save");

    const fields = data.fields as Array<AnyRecord>;
    expect(fields).toHaveLength(3);

    // Text field
    expect(fields[0].id).toBe("name");
    expect(fields[0].type).toBe("text");
    expect(fields[0].label).toBe("Display Name");
    expect(fields[0].placeholder).toBe("Enter your name");
    expect(fields[0].required).toBe(true);

    // Select field
    expect(fields[1].id).toBe("theme");
    expect(fields[1].type).toBe("select");
    expect(fields[1].label).toBe("Theme");
    expect(fields[1].options).toEqual([
      { label: "Light", value: "light" },
      { label: "Dark", value: "dark" },
    ]);
    expect(fields[1].defaultValue).toBe("dark");

    // Toggle field
    expect(fields[2].id).toBe("notifications");
    expect(fields[2].type).toBe("toggle");
    expect(fields[2].label).toBe("Enable notifications");
    expect(fields[2].defaultValue).toBe(true);

    // Resolve to avoid dangling timer
    await handleSurfaceAction(ctx, "payload-surf-form-1", "submit", {
      name: "Alice",
    });
    await resultPromise;
  });

  test("ui_surface_complete payload on form submit matches UiSurfaceCompleteMessage contract", async () => {
    const ctx = createMockContext();

    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "payload-test-conv",
        surfaceType: "form",
        title: "User info",
        data: {
          fields: [
            { id: "email", type: "text", label: "Email", required: true },
            { id: "age", type: "number", label: "Age" },
          ],
        },
        timeoutMs: 60_000,
      },
      "payload-surf-form-2",
    );

    ctx.sentMessages.length = 0;

    await handleSurfaceAction(ctx, "payload-surf-form-2", "submit", {
      email: "alice@example.com",
      age: 30,
    });
    await resultPromise;

    const completeMsg = findByType(ctx.sentMessages, "ui_surface_complete");
    expect(completeMsg).toBeDefined();

    expect(completeMsg!.type).toBe("ui_surface_complete");
    expect(completeMsg!.conversationId).toBe("payload-test-conv");
    expect(completeMsg!.surfaceId).toBe("payload-surf-form-2");
    expect(completeMsg!.summary).toBe("Submitted");
    expect(completeMsg!.submittedData).toEqual({
      email: "alice@example.com",
      age: 30,
    });
  });

  test("form dismiss action resolves as cancelled with correct payload", async () => {
    const ctx = createMockContext();

    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "payload-test-conv",
        surfaceType: "form",
        data: { fields: [{ id: "x", type: "text", label: "X" }] },
        timeoutMs: 60_000,
      },
      "payload-surf-form-3",
    );

    ctx.sentMessages.length = 0;

    await handleSurfaceAction(ctx, "payload-surf-form-3", "dismiss");
    const result = await resultPromise;

    // Standalone result
    expect(result.status).toBe("cancelled");
    expect(result.surfaceId).toBe("payload-surf-form-3");
    expect(result.actionId).toBe("dismiss");

    // Client-facing ui_surface_complete
    const completeMsg = findByType(ctx.sentMessages, "ui_surface_complete");
    expect(completeMsg).toBeDefined();
    expect(completeMsg!.surfaceId).toBe("payload-surf-form-3");
    expect(typeof completeMsg!.summary).toBe("string");
  });
});

// ── Cross-surface contract invariants ────────────────────────────────

describe("standalone surface contract invariants", () => {
  test("standalone surfaces never enqueue LLM messages", async () => {
    const ctx = createMockContext();

    // Confirmation flow
    const p1 = showStandaloneSurface(
      ctx,
      {
        conversationId: "payload-test-conv",
        surfaceType: "confirmation",
        data: { message: "Yes?" },
        timeoutMs: 60_000,
      },
      "invariant-surf-1",
    );
    await handleSurfaceAction(ctx, "invariant-surf-1", "confirm");
    await p1;

    // Form flow
    const p2 = showStandaloneSurface(
      ctx,
      {
        conversationId: "payload-test-conv",
        surfaceType: "form",
        data: { fields: [] },
        timeoutMs: 60_000,
      },
      "invariant-surf-2",
    );
    await handleSurfaceAction(ctx, "invariant-surf-2", "submit", {
      val: "test",
    });
    await p2;

    // No messages should have been enqueued to the LLM for standalone surfaces
    expect(ctx.enqueuedMessages).toHaveLength(0);
  });

  test("every ui_surface_show has required fields for Swift deserialization", async () => {
    const ctx = createMockContext();

    const p1 = showStandaloneSurface(
      ctx,
      {
        conversationId: "payload-test-conv",
        surfaceType: "confirmation",
        data: { message: "A?" },
        timeoutMs: 60_000,
      },
      "schema-surf-1",
    );

    const p2 = showStandaloneSurface(
      ctx,
      {
        conversationId: "payload-test-conv",
        surfaceType: "form",
        data: { fields: [] },
        timeoutMs: 60_000,
      },
      "schema-surf-2",
    );

    const showMessages = findAllByType(ctx.sentMessages, "ui_surface_show");
    expect(showMessages).toHaveLength(2);

    for (const msg of showMessages) {
      // Required fields per UiSurfaceShowMessage(Decodable) in MessageTypes.swift:
      //   conversationId: String? — present (nullable but present)
      //   surfaceId: String       — required
      //   surfaceType: String     — required
      //   data: AnyCodable        — required
      expect(msg).toHaveProperty("conversationId");
      expect(typeof msg.surfaceId).toBe("string");
      expect(typeof msg.surfaceType).toBe("string");
      expect(msg.data).toBeDefined();
      expect(msg.data).not.toBeNull();
    }

    // Cleanup
    await handleSurfaceAction(ctx, "schema-surf-1", "confirm");
    await handleSurfaceAction(ctx, "schema-surf-2", "submit", {});
    await p1;
    await p2;
  });

  test("every ui_surface_complete has required fields for Swift deserialization", async () => {
    const ctx = createMockContext();

    const p1 = showStandaloneSurface(
      ctx,
      {
        conversationId: "payload-test-conv",
        surfaceType: "confirmation",
        data: { message: "B?" },
        timeoutMs: 60_000,
      },
      "schema-surf-3",
    );
    await handleSurfaceAction(ctx, "schema-surf-3", "confirm");
    await p1;

    const p2 = showStandaloneSurface(
      ctx,
      {
        conversationId: "payload-test-conv",
        surfaceType: "form",
        data: { fields: [] },
        timeoutMs: 60_000,
      },
      "schema-surf-4",
    );
    await handleSurfaceAction(ctx, "schema-surf-4", "submit", { k: "v" });
    await p2;

    const completeMessages = findAllByType(
      ctx.sentMessages,
      "ui_surface_complete",
    );
    expect(completeMessages.length).toBeGreaterThanOrEqual(2);

    for (const msg of completeMessages) {
      // Required fields per UiSurfaceCompleteMessage(Decodable) in MessageTypes.swift:
      //   conversationId: String? — present (nullable but present)
      //   surfaceId: String       — required
      //   summary: String         — required
      //   submittedData: [String: AnyCodable]? — optional
      expect(msg).toHaveProperty("conversationId");
      expect(typeof msg.surfaceId).toBe("string");
      expect(typeof msg.summary).toBe("string");
      expect(msg.summary).not.toBe("");
    }
  });

  test("standalone surface cleanup leaves no stale state", async () => {
    const ctx = createMockContext();

    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "payload-test-conv",
        surfaceType: "confirmation",
        data: { message: "Clean?" },
        timeoutMs: 60_000,
      },
      "cleanup-surf-1",
    );

    // Verify state exists before action
    expect(ctx.pendingStandaloneSurfaces!.has("cleanup-surf-1")).toBe(true);
    expect(ctx.surfaceState.has("cleanup-surf-1")).toBe(true);

    await handleSurfaceAction(ctx, "cleanup-surf-1", "confirm");
    await resultPromise;

    // After resolution, all related state maps should be clean
    expect(ctx.pendingStandaloneSurfaces!.has("cleanup-surf-1")).toBe(false);
    expect(ctx.surfaceState.has("cleanup-surf-1")).toBe(false);
    expect(ctx.pendingSurfaceActions.has("cleanup-surf-1")).toBe(false);
    expect(ctx.lastSurfaceAction.has("cleanup-surf-1")).toBe(false);
    expect(ctx.accumulatedSurfaceState.has("cleanup-surf-1")).toBe(false);
    expect(ctx.surfaceUndoStacks.has("cleanup-surf-1")).toBe(false);
  });

  test("action variant mapping: danger → destructive, unset → secondary", async () => {
    const ctx = createMockContext();

    const resultPromise = showStandaloneSurface(
      ctx,
      {
        conversationId: "payload-test-conv",
        surfaceType: "confirmation",
        data: { message: "Variants?" },
        actions: [
          { id: "a", label: "Primary", variant: "primary" },
          { id: "b", label: "Danger", variant: "danger" },
          { id: "c", label: "Secondary", variant: "secondary" },
          { id: "d", label: "Default" }, // no variant
        ],
        timeoutMs: 60_000,
      },
      "variant-surf-1",
    );

    const showMsg = findByType(ctx.sentMessages, "ui_surface_show");
    const actions = showMsg!.actions as Array<AnyRecord>;

    // Verify the mapping matches what Swift SurfaceActionButton expects:
    //   "primary" → "primary"
    //   "danger" → "destructive"
    //   "secondary" → "secondary"
    //   undefined → "secondary" (default)
    expect(actions[0].style).toBe("primary");
    expect(actions[1].style).toBe("destructive");
    expect(actions[2].style).toBe("secondary");
    expect(actions[3].style).toBe("secondary");

    await handleSurfaceAction(ctx, "variant-surf-1", "a");
    await resultPromise;
  });
});

// ── Completion summary consistency ───────────────────────────────────

describe("buildCompletionSummary for standalone surfaces", () => {
  test("confirmation confirm with custom label", () => {
    expect(
      buildCompletionSummary(
        "confirmation",
        "confirm",
        {},
        { confirmLabel: "Yes, proceed" },
      ),
    ).toBe('User chose: "Yes, proceed"');
  });

  test("confirmation confirm without custom label", () => {
    expect(buildCompletionSummary("confirmation", "confirm", {}, {})).toBe(
      "Confirmed",
    );
  });

  test("confirmation cancel with custom label", () => {
    expect(
      buildCompletionSummary(
        "confirmation",
        "cancel",
        {},
        { cancelLabel: "Never mind" },
      ),
    ).toBe('User chose: "Never mind"');
  });

  test("confirmation cancel without custom label", () => {
    expect(buildCompletionSummary("confirmation", "cancel", {}, {})).toBe(
      "Cancelled",
    );
  });

  test("form submit", () => {
    expect(buildCompletionSummary("form", "submit", { k: "v" })).toBe(
      "Submitted",
    );
  });

  test("confirmation deny with custom cancelLabel uses the label", () => {
    expect(
      buildCompletionSummary(
        "confirmation",
        "deny",
        {},
        { cancelLabel: "Keep" },
      ),
    ).toBe('User chose: "Keep"');
  });

  test("confirmation deny without custom label returns Denied", () => {
    expect(buildCompletionSummary("confirmation", "deny", {}, {})).toBe(
      "Denied",
    );
  });

  test("unknown action ID is passed through", () => {
    expect(buildCompletionSummary("confirmation", "reject", {}, {})).toBe(
      "User selected: reject",
    );
  });
});
