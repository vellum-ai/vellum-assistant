import { describe, expect, test } from "bun:test";

import {
  createSurfaceMutex,
  handleSurfaceAction,
  restoreSurfaceStateEntry,
  type SurfaceConversationContext,
  surfaceProxyResolver,
} from "../daemon/conversation-surfaces.js";
import type { ServerMessage, SurfaceType } from "../daemon/message-protocol.js";

/**
 * Build a minimal SurfaceConversationContext for testing.
 * Tracks calls to enqueueMessage and processMessage so tests can assert
 * whether an LLM turn was triggered.
 */
function makeContext(opts?: {
  sent?: ServerMessage[];
}): SurfaceConversationContext & {
  enqueueCalls: Array<{ content: string; requestId: string }>;
  processCalls: Array<{ content: string; requestId?: string }>;
} {
  const sent = opts?.sent ?? [];
  const enqueueCalls: Array<{ content: string; requestId: string }> = [];
  const processCalls: Array<{ content: string; requestId?: string }> = [];

  return {
    conversationId: "test-session",
    sendToClient: (msg) => sent.push(msg),
    pendingSurfaceActions: new Map<string, { surfaceType: SurfaceType }>(),
    lastSurfaceAction: new Map<
      string,
      { actionId: string; data?: Record<string, unknown> }
    >(),
    surfaceState: new Map(),
    surfaceUndoStacks: new Map<string, string[]>(),
    accumulatedSurfaceState: new Map<string, Record<string, unknown>>(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],
    isProcessing: () => false,
    enqueueMessage: (options) => {
      const resolvedId = options.requestId ?? "mock-request-id";
      enqueueCalls.push({ content: options.content, requestId: resolvedId });
      return { queued: false, requestId: resolvedId };
    },
    getQueueDepth: () => 0,
    processMessage: async (options) => {
      processCalls.push({
        content: options.content,
        requestId: options.requestId,
      });
      return "ok";
    },
    withSurface: createSurfaceMutex(),
    enqueueCalls,
    processCalls,
  };
}

/** Register a dynamic_page surface in the context so state_update is accepted. */
function registerDynamicPage(
  ctx: SurfaceConversationContext,
  surfaceId: string,
): void {
  ctx.pendingSurfaceActions.set(surfaceId, { surfaceType: "dynamic_page" });
  ctx.surfaceState.set(surfaceId, {
    surfaceType: "dynamic_page",
    data: { html: "<div>test</div>" },
  });
}

describe("state_update silent accumulation", () => {
  test("accumulates state from multiple calls via shallow merge", () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-1");

    handleSurfaceAction(ctx, "surface-1", "state_update", { page: 2 });
    handleSurfaceAction(ctx, "surface-1", "state_update", {
      selectedTab: "overview",
    });
    handleSurfaceAction(ctx, "surface-1", "state_update", { page: 5 });

    const accumulated = ctx.accumulatedSurfaceState.get("surface-1");
    expect(accumulated).toEqual({ page: 5, selectedTab: "overview" });
  });

  test("ignores calls with undefined data", () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-1");

    handleSurfaceAction(ctx, "surface-1", "state_update", { count: 1 });
    handleSurfaceAction(ctx, "surface-1", "state_update", undefined);

    const accumulated = ctx.accumulatedSurfaceState.get("surface-1");
    expect(accumulated).toEqual({ count: 1 });
  });

  test("does not accumulate for non-dynamic_page surfaces", () => {
    const ctx = makeContext();
    // Register as a table surface instead of dynamic_page
    ctx.pendingSurfaceActions.set("surface-table", { surfaceType: "table" });
    ctx.surfaceState.set("surface-table", {
      surfaceType: "table",
      data: {
        columns: [],
        rows: [],
      },
    });

    handleSurfaceAction(ctx, "surface-table", "state_update", { page: 1 });

    const accumulated = ctx.accumulatedSurfaceState.get("surface-table");
    expect(accumulated).toBeUndefined();
  });
});

describe("state_update does not trigger LLM", () => {
  test("does not call enqueueMessage or processMessage", () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-1");

    handleSurfaceAction(ctx, "surface-1", "state_update", {
      currentSlide: 3,
    });

    expect(ctx.enqueueCalls).toHaveLength(0);
    expect(ctx.processCalls).toHaveLength(0);
  });

  test("does not add to surfaceActionRequestIds", () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-1");

    handleSurfaceAction(ctx, "surface-1", "state_update", { zoom: 1.5 });

    expect(ctx.surfaceActionRequestIds.size).toBe(0);
  });
});

describe("accumulated state injection into reactive actions", () => {
  test("subsequent reactive action includes accumulated state in message content", () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-1");

    // Accumulate some state
    handleSurfaceAction(ctx, "surface-1", "state_update", { page: 3 });
    handleSurfaceAction(ctx, "surface-1", "state_update", {
      selectedItem: "item-42",
    });

    // Fire a reactive action (e.g. "save")
    handleSurfaceAction(ctx, "surface-1", "save");

    // The enqueueMessage call should include the accumulated state
    expect(ctx.enqueueCalls).toHaveLength(1);
    const content = ctx.enqueueCalls[0].content;
    expect(content).toContain("Accumulated surface state:");
    expect(content).toContain('"page":3');
    expect(content).toContain('"selectedItem":"item-42"');
  });

  test("empty accumulated state is not appended", () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-1");

    // Fire a reactive action without any prior state_update
    handleSurfaceAction(ctx, "surface-1", "refresh");

    expect(ctx.enqueueCalls).toHaveLength(1);
    const content = ctx.enqueueCalls[0].content;
    expect(content).not.toContain("Accumulated surface state:");
  });
});

describe("per-surface state isolation", () => {
  test("accumulated state from surface A does not appear in surface B reactive action", () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-a");
    registerDynamicPage(ctx, "surface-b");

    // Accumulate state only on surface A
    handleSurfaceAction(ctx, "surface-a", "state_update", {
      filterA: "active",
    });

    // Fire a reactive action on surface B
    handleSurfaceAction(ctx, "surface-b", "submit");

    expect(ctx.enqueueCalls).toHaveLength(1);
    const content = ctx.enqueueCalls[0].content;
    expect(content).not.toContain("filterA");
    expect(content).not.toContain("Accumulated surface state:");
  });

  test("each surface maintains its own accumulated state", () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-a");
    registerDynamicPage(ctx, "surface-b");

    handleSurfaceAction(ctx, "surface-a", "state_update", { page: 1 });
    handleSurfaceAction(ctx, "surface-b", "state_update", { page: 99 });

    expect(ctx.accumulatedSurfaceState.get("surface-a")).toEqual({ page: 1 });
    expect(ctx.accumulatedSurfaceState.get("surface-b")).toEqual({ page: 99 });
  });
});

describe("cleanup on dismiss", () => {
  test("ui_dismiss clears accumulated state for the surface", async () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-1");

    // Accumulate state
    handleSurfaceAction(ctx, "surface-1", "state_update", { dirty: true });
    expect(ctx.accumulatedSurfaceState.get("surface-1")).toEqual({
      dirty: true,
    });

    // Dismiss via surfaceProxyResolver (ui_dismiss)
    await surfaceProxyResolver(ctx, "ui_dismiss", {
      surface_id: "surface-1",
    });

    // Accumulated state should be cleared
    expect(ctx.accumulatedSurfaceState.has("surface-1")).toBe(false);
  });

  test("ui_dismiss does not affect other surfaces accumulated state", async () => {
    const ctx = makeContext();
    registerDynamicPage(ctx, "surface-1");
    registerDynamicPage(ctx, "surface-2");

    handleSurfaceAction(ctx, "surface-1", "state_update", { x: 1 });
    handleSurfaceAction(ctx, "surface-2", "state_update", { y: 2 });

    await surfaceProxyResolver(ctx, "ui_dismiss", {
      surface_id: "surface-1",
    });

    expect(ctx.accumulatedSurfaceState.has("surface-1")).toBe(false);
    expect(ctx.accumulatedSurfaceState.get("surface-2")).toEqual({ y: 2 });
  });
});

describe("ui_update preserves client-owned keys the daemon schema omits", () => {
  test("a valid patch keeps unmodeled keys on the merged, sent, and stored data", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext({ sent });
    // A document_preview whose stored data carries `content`/`mimeType`
    // (read by the client renderer, not modeled by the daemon schema).
    // Built the way history restore produces it (verbatim client-owned keys).
    ctx.surfaceState.set(
      "doc-1",
      restoreSurfaceStateEntry({
        surfaceType: "document_preview",
        data: {
          title: "Notes",
          surfaceId: "doc-real",
          content: "# Heading",
          mimeType: "text/markdown",
        },
      }),
    );

    const result = await surfaceProxyResolver(ctx, "ui_update", {
      surface_id: "doc-1",
      data: { title: "Notes (edited)" },
    });
    expect(result.isError).toBe(false);

    // Stored state keeps the unmodeled keys and applies the patch.
    expect(ctx.surfaceState.get("doc-1")?.data).toEqual({
      title: "Notes (edited)",
      surfaceId: "doc-real",
      content: "# Heading",
      mimeType: "text/markdown",
    });

    // The update sent to the client also carries them verbatim.
    const update = sent.find((m) => m.type === "ui_surface_update");
    expect(update).toBeDefined();
    expect((update as { data: Record<string, unknown> }).data).toEqual({
      title: "Notes (edited)",
      surfaceId: "doc-real",
      content: "# Heading",
      mimeType: "text/markdown",
    });
  });
});

describe("ui_update on a restored unknown surface type", () => {
  test("forwards the merge opaquely instead of throwing on the schema registry", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext({ sent });
    // Restore preserves an unknown-but-non-empty surfaceType verbatim (a
    // newer/custom client-rendered surface). Indexing SURFACE_DATA_SCHEMAS with
    // it would read `undefined` and throw — the update must forward opaquely.
    ctx.surfaceState.set(
      "future-1",
      restoreSurfaceStateEntry({
        surfaceType: "future_widget",
        data: { title: "Widget", customField: 42 },
      }),
    );

    const result = await surfaceProxyResolver(ctx, "ui_update", {
      surface_id: "future-1",
      data: { title: "Widget (edited)" },
    });
    expect(result.isError).toBe(false);

    // The unknown type is preserved and the merge applied verbatim.
    const stored = ctx.surfaceState.get("future-1");
    expect(stored?.surfaceType as string).toBe("future_widget");
    expect(stored?.data).toEqual({ title: "Widget (edited)", customField: 42 });

    const update = sent.find((m) => m.type === "ui_surface_update");
    expect(update).toBeDefined();
    expect((update as { data: Record<string, unknown> }).data).toEqual({
      title: "Widget (edited)",
      customField: 42,
    });
  });

  test("also syncs the current-turn snapshot so the two persist writers agree", async () => {
    const ctx = makeContext();
    ctx.surfaceState.set(
      "future-1",
      restoreSurfaceStateEntry({
        surfaceType: "future_widget",
        data: { title: "Widget", customField: 42 },
      }),
    );
    // The surface is also tracked in the current turn: the turn-end persist
    // loop writes `currentTurnSurfaces[i].data` to the same ui_surface block
    // that the debounced persist writes. If this snapshot were left stale for
    // an opaquely-forwarded (unknown-type) update, the two writers would race
    // on divergent data.
    ctx.currentTurnSurfaces.push({
      surfaceId: "future-1",
      surfaceType: "future_widget",
      data: { title: "Widget", customField: 42 },
    } as unknown as (typeof ctx.currentTurnSurfaces)[number]);

    const result = await surfaceProxyResolver(ctx, "ui_update", {
      surface_id: "future-1",
      data: { title: "Widget (edited)" },
    });
    expect(result.isError).toBe(false);

    // The current-turn snapshot reflects the update, matching surfaceState.
    expect(ctx.currentTurnSurfaces[0]?.data as Record<string, unknown>).toEqual(
      {
        title: "Widget (edited)",
        customField: 42,
      },
    );
  });
});

describe("ui_update normalizes modeled fields for known surface types", () => {
  test("a malformed dynamic_page html patch is stored as its schema-coerced string", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext({ sent });
    ctx.surfaceState.set("page-1", {
      surfaceType: "dynamic_page",
      data: { html: "<p>original</p>" },
    });

    // A malformed patch: `html` as a non-string. The tolerant schema
    // (`z.string().catch("")`) accepts it, so the update must not revert — but
    // the stored/sent value must be the coerced string, never the raw object,
    // or later `truncateHtml(...).slice()` on the stored html would crash.
    const result = await surfaceProxyResolver(ctx, "ui_update", {
      surface_id: "page-1",
      data: { html: { unexpected: "object" } },
    });
    expect(result.isError).toBe(false);

    const storedHtml = (
      ctx.surfaceState.get("page-1")?.data as { html: unknown }
    ).html;
    expect(typeof storedHtml).toBe("string");

    const update = sent.find((m) => m.type === "ui_surface_update");
    expect(update).toBeDefined();
    expect(typeof (update as { data: { html: unknown } }).data.html).toBe(
      "string",
    );
  });
});
