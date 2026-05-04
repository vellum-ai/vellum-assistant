import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the persistence layer the surface helpers reach into so we can
// observe writes without touching SQLite. We swap this out per test by
// re-assigning the spies recorded on the closure below.
let getMessagesImpl: (conversationId: string) => Array<{
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: number;
  metadata: string | null;
}> = () => [];
let updateMessageContentSpy: (id: string, content: string) => void = () => {};

const realCrud = await import("../memory/conversation-crud.js");

mock.module("../memory/conversation-crud.js", () => ({
  ...realCrud,
  getMessages: (conversationId: string) => getMessagesImpl(conversationId),
  updateMessageContent: (id: string, content: string) =>
    updateMessageContentSpy(id, content),
}));

// Imports must come AFTER mock.module so the surface module picks up
// the mocked persistence functions.
const {
  cancelPendingSurfaceDataPersists,
  flushPendingSurfaceDataPersists,
  createSurfaceMutex,
  flushSurfaceDataPersist,
  markSurfaceCompleted,
  scheduleSurfaceDataPersist,
  surfaceProxyResolver,
} = await import("../daemon/conversation-surfaces.js");

import type { SurfaceConversationContext } from "../daemon/conversation-surfaces.js";
import type {
  CardSurfaceData,
  ServerMessage,
  SurfaceData,
  SurfaceType,
} from "../daemon/message-protocol.js";

function makeContext(sent: ServerMessage[] = []): SurfaceConversationContext {
  return {
    conversationId: "conv-persist-1",
    traceEmitter: { emit: () => {} },
    sendToClient: (msg) => sent.push(msg),
    pendingSurfaceActions: new Map<string, { surfaceType: SurfaceType }>(),
    lastSurfaceAction: new Map<
      string,
      { actionId: string; data?: Record<string, unknown> }
    >(),
    surfaceState: new Map<
      string,
      { surfaceType: SurfaceType; data: SurfaceData; title?: string }
    >(),
    surfaceUndoStacks: new Map<string, string[]>(),
    accumulatedSurfaceState: new Map<string, Record<string, unknown>>(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: false, requestId: "req-1" }),
    getQueueDepth: () => 0,
    processMessage: async () => "ok",
    withSurface: createSurfaceMutex(),
  };
}

function seedRows(rows: Array<{ id: string; content: unknown }>): void {
  getMessagesImpl = () =>
    rows.map((r) => ({
      id: r.id,
      conversationId: "conv-persist-1",
      role: "assistant",
      content:
        typeof r.content === "string" ? r.content : JSON.stringify(r.content),
      createdAt: 0,
      metadata: null,
    }));
}

describe("ui_surface_update persistence", () => {
  let writes: Array<{ id: string; content: unknown }> = [];

  beforeEach(() => {
    writes = [];
    updateMessageContentSpy = (id: string, content: string) => {
      writes.push({ id, content: JSON.parse(content) });
    };
    getMessagesImpl = () => [];
    // Make sure module-level pending timers from a previous test don't
    // leak into this one.
    cancelPendingSurfaceDataPersists();
  });

  afterEach(() => {
    cancelPendingSurfaceDataPersists();
  });

  test("ui_update schedules a debounced DB write that lands within ~600ms", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    // Seed an existing in-memory surface and a persisted message that
    // contains the matching ui_surface block.
    const surfaceId = "surface-debounced-1";
    const initial: CardSurfaceData = {
      title: "Health check",
      body: "",
      template: "task_progress",
      templateData: { status: "in_progress", steps: [] },
    };
    ctx.surfaceState.set(surfaceId, { surfaceType: "card", data: initial });
    seedRows([
      {
        id: "msg-1",
        content: [
          { type: "text", text: "running" },
          {
            type: "ui_surface",
            surfaceId,
            surfaceType: "card",
            data: initial,
          },
        ],
      },
    ]);

    const result = await surfaceProxyResolver(ctx, "ui_update", {
      surface_id: surfaceId,
      data: { templateData: { status: "completed" } },
    });
    expect(result.isError).toBe(false);

    // Write must not have happened synchronously.
    expect(writes).toHaveLength(0);

    // After the debounce window the write lands.
    await new Promise((r) => setTimeout(r, 600));
    expect(writes).toHaveLength(1);
    expect(writes[0].id).toBe("msg-1");
    const persistedBlocks = writes[0].content as Array<Record<string, unknown>>;
    const persistedSurface = persistedBlocks.find(
      (b) => b.type === "ui_surface",
    );
    expect(persistedSurface).toBeDefined();
    const persistedData = persistedSurface!.data as CardSurfaceData;
    expect((persistedData.templateData as Record<string, unknown>).status).toBe(
      "completed",
    );
  });

  test("multiple rapid updates collapse to a single DB write", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const surfaceId = "surface-debounced-2";
    const initial: CardSurfaceData = {
      title: "Health check",
      body: "",
      template: "task_progress",
      templateData: { status: "in_progress", steps: [] },
    };
    ctx.surfaceState.set(surfaceId, { surfaceType: "card", data: initial });
    seedRows([
      {
        id: "msg-2",
        content: [
          {
            type: "ui_surface",
            surfaceId,
            surfaceType: "card",
            data: initial,
          },
        ],
      },
    ]);

    for (const status of ["a", "b", "c", "d"]) {
      // Patches arrive faster than the debounce window.
      await surfaceProxyResolver(ctx, "ui_update", {
        surface_id: surfaceId,
        data: { templateData: { status } },
      });
      await new Promise((r) => setTimeout(r, 50));
    }

    // Wait past the debounce window after the LAST update.
    await new Promise((r) => setTimeout(r, 600));

    expect(writes).toHaveLength(1);
    const persistedSurface = (
      writes[0].content as Array<Record<string, unknown>>
    ).find((b) => b.type === "ui_surface");
    const persistedData = persistedSurface!.data as CardSurfaceData;
    expect((persistedData.templateData as Record<string, unknown>).status).toBe(
      "d",
    );
  });

  test("markSurfaceCompleted force-flushes any pending debounced write", async () => {
    const surfaceId = "surface-flush-1";
    const initial: CardSurfaceData = {
      title: "x",
      body: "",
      template: "task_progress",
      templateData: { status: "in_progress" },
    };
    seedRows([
      {
        id: "msg-flush",
        content: [
          {
            type: "ui_surface",
            surfaceId,
            surfaceType: "card",
            data: initial,
          },
        ],
      },
    ]);

    // Schedule a debounced persist directly.
    scheduleSurfaceDataPersist("conv-persist-1", surfaceId, {
      ...initial,
      templateData: { status: "completed" },
    } as SurfaceData);

    expect(writes).toHaveLength(0);

    // Calling markSurfaceCompleted should immediately flush the pending
    // data persist AND apply its own completion patch — two writes
    // against the same row, with the completion landing last.
    markSurfaceCompleted({ conversationId: "conv-persist-1" }, surfaceId, "ok");

    expect(writes.length).toBeGreaterThanOrEqual(2);
    const finalBlocks = writes[writes.length - 1].content as Array<
      Record<string, unknown>
    >;
    const finalSurface = finalBlocks.find((b) => b.type === "ui_surface")!;
    expect(finalSurface.completed).toBe(true);
    expect(finalSurface.completionSummary).toBe("ok");
  });

  test("flushSurfaceDataPersist fires the latest data immediately", () => {
    const surfaceId = "surface-flush-2";
    seedRows([
      {
        id: "msg-flush-2",
        content: [
          {
            type: "ui_surface",
            surfaceId,
            surfaceType: "card",
            data: { title: "x", body: "" },
          },
        ],
      },
    ]);
    scheduleSurfaceDataPersist("conv-persist-1", surfaceId, {
      title: "x",
      body: "later",
    } as SurfaceData);

    expect(writes).toHaveLength(0);
    flushSurfaceDataPersist(surfaceId);
    expect(writes).toHaveLength(1);
    const block = (writes[0].content as Array<Record<string, unknown>>).find(
      (b) => b.type === "ui_surface",
    );
    expect((block!.data as Record<string, unknown>).body).toBe("later");
  });

  test("update arriving before the message is persisted is safely skipped", async () => {
    const surfaceId = "surface-orphan-1";
    // No rows seeded — simulates mid-stream before message_complete persists.
    seedRows([]);

    scheduleSurfaceDataPersist("conv-persist-1", surfaceId, {
      title: "x",
      body: "",
    } as SurfaceData);

    await new Promise((r) => setTimeout(r, 600));

    // No write — and no crash.
    expect(writes).toHaveLength(0);
  });

  test("cancelPendingSurfaceDataPersists clears scoped timers without firing", async () => {
    const surfaceId = "surface-cancel-1";
    seedRows([
      {
        id: "msg-cancel",
        content: [
          {
            type: "ui_surface",
            surfaceId,
            surfaceType: "card",
            data: { title: "x", body: "" },
          },
        ],
      },
    ]);

    scheduleSurfaceDataPersist("conv-persist-1", surfaceId, {
      title: "x",
      body: "queued",
    } as SurfaceData);

    cancelPendingSurfaceDataPersists("conv-persist-1");
    await new Promise((r) => setTimeout(r, 600));

    expect(writes).toHaveLength(0);
  });

  test("flushPendingSurfaceDataPersists writes pending updates synchronously and clears timers", async () => {
    const surfaceId = "surface-flush-pending-1";
    seedRows([
      {
        id: "msg-flush-pending",
        content: [
          {
            type: "ui_surface",
            surfaceId,
            surfaceType: "card",
            data: { title: "x", body: "" },
          },
        ],
      },
    ]);

    scheduleSurfaceDataPersist("conv-persist-1", surfaceId, {
      title: "x",
      body: "shutdown-flush",
    } as SurfaceData);

    // Write should not have fired yet (debounce hasn't elapsed).
    expect(writes).toHaveLength(0);

    flushPendingSurfaceDataPersists("conv-persist-1");

    // Synchronous flush — write lands immediately with the latest data.
    expect(writes).toHaveLength(1);
    expect(writes[0].id).toBe("msg-flush-pending");
    const block = (writes[0].content as Array<Record<string, unknown>>).find(
      (b) => b.type === "ui_surface",
    )!;
    expect((block.data as Record<string, unknown>).body).toBe("shutdown-flush");

    // Timer is cleared — waiting past the debounce window doesn't fire again.
    await new Promise((r) => setTimeout(r, 600));
    expect(writes).toHaveLength(1);
  });

  test("flushPendingSurfaceDataPersists scoped to one conversation leaves other conversations' timers alone", async () => {
    const surfaceA = "surface-flush-scoped-a";
    const surfaceB = "surface-flush-scoped-b";
    seedRows([
      {
        id: "msg-scoped-a",
        content: [
          {
            type: "ui_surface",
            surfaceId: surfaceA,
            surfaceType: "card",
            data: { title: "x", body: "" },
          },
        ],
      },
      {
        id: "msg-scoped-b",
        content: [
          {
            type: "ui_surface",
            surfaceId: surfaceB,
            surfaceType: "card",
            data: { title: "x", body: "" },
          },
        ],
      },
    ]);

    scheduleSurfaceDataPersist("conv-persist-1", surfaceA, {
      title: "x",
      body: "a",
    } as SurfaceData);
    scheduleSurfaceDataPersist("conv-other", surfaceB, {
      title: "x",
      body: "b",
    } as SurfaceData);

    flushPendingSurfaceDataPersists("conv-persist-1");

    // Only conv-persist-1's surface flushed; conv-other's still pending.
    expect(writes).toHaveLength(1);
    expect(writes[0].id).toBe("msg-scoped-a");

    // Cleanup the other conversation's timer.
    cancelPendingSurfaceDataPersists("conv-other");
  });
});
