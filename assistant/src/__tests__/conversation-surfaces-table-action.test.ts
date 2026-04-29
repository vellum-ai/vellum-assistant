import { describe, expect, test } from "bun:test";

import {
  createSurfaceMutex,
  handleSurfaceAction,
  type SurfaceConversationContext,
} from "../daemon/conversation-surfaces.js";
import type {
  ServerMessage,
  SurfaceData,
  SurfaceType,
} from "../daemon/message-protocol.js";

/**
 * Build a minimal SurfaceConversationContext for testing table surface actions.
 * Tracks calls to enqueueMessage and processMessage so tests can assert
 * whether an LLM turn was triggered with the correct content.
 */
function makeContext(): SurfaceConversationContext & {
  enqueueCalls: Array<{
    content: string;
    requestId: string;
    attachments: unknown[];
    surfaceId?: string;
    displayContent?: string;
  }>;
  processCalls: Array<{
    content: string;
    requestId?: string;
    attachments: unknown[];
    surfaceId?: string;
    displayContent?: string;
  }>;
  sentMessages: ServerMessage[];
} {
  const enqueueCalls: Array<{
    content: string;
    requestId: string;
    attachments: unknown[];
    surfaceId?: string;
    displayContent?: string;
  }> = [];
  const processCalls: Array<{
    content: string;
    requestId?: string;
    attachments: unknown[];
    surfaceId?: string;
    displayContent?: string;
  }> = [];
  const sentMessages: ServerMessage[] = [];

  return {
    conversationId: "test-convo",
    traceEmitter: { emit: () => {} },
    sendToClient: (msg) => sentMessages.push(msg),
    pendingSurfaceActions: new Map<string, { surfaceType: SurfaceType }>(),
    lastSurfaceAction: new Map<
      string,
      { actionId: string; data?: Record<string, unknown> }
    >(),
    surfaceState: new Map(),
    surfaceUndoStacks: new Map(),
    accumulatedSurfaceState: new Map(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],
    isProcessing: () => false,
    enqueueMessage: (
      content,
      attachments,
      _onEvent,
      requestId,
      surfaceId,
      _currentPage,
      _metadata,
      _options,
      displayContent,
    ) => {
      enqueueCalls.push({
        content,
        requestId,
        attachments,
        surfaceId,
        displayContent,
      });
      return { queued: false, requestId };
    },
    getQueueDepth: () => 0,
    processMessage: async (
      content,
      attachments,
      _onEvent,
      requestId,
      surfaceId,
      _currentPage,
      _options,
      displayContent,
    ) => {
      processCalls.push({
        content,
        requestId,
        attachments,
        surfaceId,
        displayContent,
      });
      return "ok";
    },
    withSurface: createSurfaceMutex(),
    enqueueCalls,
    processCalls,
    sentMessages,
  };
}

/**
 * Register a table surface with selectionMode and action buttons,
 * mimicking what surfaceProxyResolver does for ui_show with await_action.
 */
function registerTableSurface(
  ctx: SurfaceConversationContext,
  surfaceId: string,
  opts?: {
    selectionMode?: "single" | "multiple" | "none";
    rows?: Array<{
      id: string;
      cells: Record<string, string>;
      selectable?: boolean;
    }>;
    actions?: Array<{
      id: string;
      label: string;
      style?: string;
      data?: Record<string, unknown>;
    }>;
  },
): void {
  const rows = opts?.rows ?? [
    {
      id: "r1",
      cells: { from: "alice@example.com", subject: "Meeting" },
      selectable: true,
    },
    {
      id: "r2",
      cells: { from: "bob@example.com", subject: "Update" },
      selectable: true,
    },
    {
      id: "r3",
      cells: { from: "carol@example.com", subject: "Invoice" },
      selectable: true,
    },
  ];
  const actions = opts?.actions ?? [
    { id: "archive", label: "Archive Selected", style: "primary" },
    { id: "delete", label: "Delete Selected", style: "destructive" },
  ];

  const data = {
    columns: [
      { id: "from", label: "From" },
      { id: "subject", label: "Subject" },
    ],
    rows,
    selectionMode: opts?.selectionMode ?? "multiple",
  };

  ctx.surfaceState.set(surfaceId, {
    surfaceType: "table",
    data: data as unknown as SurfaceData,
    title: "Test Table",
    actions,
  });

  ctx.pendingSurfaceActions.set(surfaceId, { surfaceType: "table" });
}

describe("table surface action with selectedIds", () => {
  test("action button click with selectedIds triggers LLM message", async () => {
    const ctx = makeContext();
    registerTableSurface(ctx, "table-1");

    await handleSurfaceAction(ctx, "table-1", "archive", {
      selectedIds: ["r1", "r3"],
    });

    // Should trigger processMessage (not enqueued since not processing)
    expect(ctx.processCalls).toHaveLength(1);
    const msg = ctx.processCalls[0];

    // Content should include action summary
    expect(msg.content).toContain("[User action on table surface:");

    // Content should include selectedIds in action data
    expect(msg.content).toContain("selectedIds");
    expect(msg.content).toContain("r1");
    expect(msg.content).toContain("r3");

    // Content should include deselection description (r2 was not selected)
    expect(msg.content).toContain("Deselected items");
    expect(msg.content).toContain("bob@example.com");

    // Should NOT contain alice or carol in deselection (they were selected)
    expect(msg.content).not.toContain("alice@example.com");
    expect(msg.content).not.toContain("carol@example.com");
  });

  test("action button click without selectedIds still triggers LLM message", async () => {
    const ctx = makeContext();
    registerTableSurface(ctx, "table-2");

    await handleSurfaceAction(ctx, "table-2", "archive", undefined);

    expect(ctx.processCalls).toHaveLength(1);
    expect(ctx.processCalls[0].content).toContain(
      "[User action on table surface:",
    );
  });

  test("selectedIds are included via action data merge", async () => {
    const ctx = makeContext();
    registerTableSurface(ctx, "table-3");

    await handleSurfaceAction(ctx, "table-3", "archive", {
      selectedIds: ["r2"],
    });

    expect(ctx.processCalls).toHaveLength(1);
    const content = ctx.processCalls[0].content;

    // Action data should contain selectedIds
    expect(content).toContain('"selectedIds":["r2"]');

    // Deselection should show r1 and r3 (not selected)
    expect(content).toContain("Deselected items");
    expect(content).toContain("alice@example.com");
    expect(content).toContain("carol@example.com");
  });

  test("pending surface action is cleared after processing", async () => {
    const ctx = makeContext();
    registerTableSurface(ctx, "table-4");

    expect(ctx.pendingSurfaceActions.has("table-4")).toBe(true);

    await handleSurfaceAction(ctx, "table-4", "archive", {
      selectedIds: ["r1"],
    });

    // Non-dynamic_page pending entries are cleared after action
    expect(ctx.pendingSurfaceActions.has("table-4")).toBe(false);
  });

  test("action with stored action data merges with client data", async () => {
    const ctx = makeContext();
    registerTableSurface(ctx, "table-5", {
      actions: [
        {
          id: "archive",
          label: "Archive",
          style: "primary",
          data: { destination: "archive-folder" },
        },
      ],
    });

    await handleSurfaceAction(ctx, "table-5", "archive", {
      selectedIds: ["r1", "r2"],
    });

    expect(ctx.processCalls).toHaveLength(1);
    const content = ctx.processCalls[0].content;

    // Both stored action data and client data should be present
    expect(content).toContain("destination");
    expect(content).toContain("archive-folder");
    expect(content).toContain("selectedIds");
  });

  test("relay_prompt action on table includes selectedIds context", async () => {
    const ctx = makeContext();
    registerTableSurface(ctx, "table-6", {
      actions: [
        {
          id: "relay_prompt",
          label: "Archive",
          style: "primary",
          data: { prompt: "Archive these selected items" },
        },
      ],
    });

    await handleSurfaceAction(ctx, "table-6", "relay_prompt", {
      selectedIds: ["r1"],
    });

    expect(ctx.processCalls).toHaveLength(1);
    const content = ctx.processCalls[0].content;

    // relay_prompt should use the prompt as content
    expect(content).toContain("Archive these selected items");

    // Should also include deselection context
    expect(content).toContain("Deselected items");
  });

  test("selection_changed action is non-terminal and does not trigger LLM", async () => {
    const ctx = makeContext();
    registerTableSurface(ctx, "table-7");

    await handleSurfaceAction(ctx, "table-7", "selection_changed", {
      selectedIds: ["r1", "r2"],
    });

    expect(ctx.enqueueCalls).toHaveLength(0);
    expect(ctx.processCalls).toHaveLength(0);

    // Pending surface should still be present (not consumed)
    expect(ctx.pendingSurfaceActions.has("table-7")).toBe(true);
  });

  test("all rows selected produces no deselection description", async () => {
    const ctx = makeContext();
    registerTableSurface(ctx, "table-8");

    await handleSurfaceAction(ctx, "table-8", "archive", {
      selectedIds: ["r1", "r2", "r3"],
    });

    expect(ctx.processCalls).toHaveLength(1);
    const content = ctx.processCalls[0].content;

    // No deselection when all are selected
    expect(content).not.toContain("Deselected items");
  });

  test("displayContent is set for non-relay actions", async () => {
    const ctx = makeContext();
    registerTableSurface(ctx, "table-9");

    await handleSurfaceAction(ctx, "table-9", "archive", {
      selectedIds: ["r1"],
    });

    expect(ctx.processCalls).toHaveLength(1);
    // displayContent should be set for non-relay actions
    expect(ctx.processCalls[0].displayContent).toBeDefined();
  });

  test("surfaceId is forwarded to processMessage", async () => {
    const ctx = makeContext();
    registerTableSurface(ctx, "table-10");

    await handleSurfaceAction(ctx, "table-10", "archive", {
      selectedIds: ["r1"],
    });

    expect(ctx.processCalls).toHaveLength(1);
    expect(ctx.processCalls[0].surfaceId).toBe("table-10");
  });
});
