import { describe, expect, test } from "bun:test";

import {
  createSurfaceMutex,
  type SurfaceConversationContext,
  surfaceProxyResolver,
} from "../daemon/conversation-surfaces.js";
import type {
  CardSurfaceData,
  DynamicPageSurfaceData,
  ServerMessage,
  SurfaceData,
  SurfaceType,
  UiSurfaceShow,
  UiSurfaceUpdate,
} from "../daemon/message-protocol.js";

function makeContext(
  sent: ServerMessage[] = [],
  channelCapabilities?: SurfaceConversationContext["channelCapabilities"],
): SurfaceConversationContext {
  return {
    conversationId: "session-1",
    channelCapabilities,
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

describe("task_progress surface compatibility", () => {
  test("blocks ui_show when channel lacks dynamic UI support", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent, {
      channel: "phone",
      supportsDynamicUi: false,
    });

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      data: { title: "Blocked", body: "blocked" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'ui_show is unavailable on channel "phone"',
    );
    expect(sent).toHaveLength(0);
  });

  test("blocks ui_update when channel lacks dynamic UI support", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent, {
      channel: "telegram",
      supportsDynamicUi: false,
    });

    const result = await surfaceProxyResolver(ctx, "ui_update", {
      surface_id: "surface-1",
      data: { status: "completed" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'ui_update is unavailable on channel "telegram"',
    );
    expect(sent).toHaveLength(0);
  });

  test("allows Slack ui_show for task_progress card when dynamic UI is otherwise disabled", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent, {
      channel: "slack",
      supportsDynamicUi: false,
    });

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Working",
      template: "task_progress",
      templateData: {
        status: "in_progress",
        steps: [{ label: "Start", status: "in_progress" }],
      },
    });

    expect(result.isError).toBe(false);
    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    );
    expect(showMessage).toBeDefined();
    if (!showMessage || showMessage.surfaceType !== "card") return;
    expect((showMessage.data as CardSurfaceData).template).toBe(
      "task_progress",
    );
  });

  test("blocks Slack ui_show for non-task_progress card when dynamic UI is disabled", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent, {
      channel: "slack",
      supportsDynamicUi: false,
    });

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Blocked",
      data: { title: "Blocked", body: "not progress" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'ui_show is unavailable on channel "slack"',
    );
    expect(sent).toHaveLength(0);
  });

  test("blocks Slack ui_show when normalized card data is not task_progress", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent, {
      channel: "slack",
      supportsDynamicUi: false,
    });

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Blocked",
      template: "task_progress",
      data: { title: "Blocked", body: "not progress", template: "plain" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'ui_show is unavailable on channel "slack"',
    );
    expect(sent).toHaveLength(0);
  });

  test("blocks Slack ui_show for non-card task_progress input when dynamic UI is disabled", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent, {
      channel: "slack",
      supportsDynamicUi: false,
    });

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "dynamic_page",
      title: "Blocked",
      data: { template: "task_progress", html: "<p>Blocked</p>" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'ui_show is unavailable on channel "slack"',
    );
    expect(sent).toHaveLength(0);
  });

  test("ui_show maps legacy top-level task_progress fields into card data", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Ordering from DoorDash",
      data: {},
      template: "task_progress",
      templateData: {
        status: "in_progress",
        steps: [
          { label: "Search restaurants", status: "in_progress" },
          { label: "Browse menu", status: "pending" },
        ],
      },
    });

    expect(result.isError).toBe(false);

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    );
    expect(showMessage).toBeDefined();
    if (!showMessage || showMessage.surfaceType !== "card") return;

    const card = showMessage.data as CardSurfaceData;
    expect(card.template).toBe("task_progress");
    expect(card.title).toBe("Ordering from DoorDash");
    expect(card.body).toBe("");
    expect((card.templateData as Record<string, unknown>).status).toBe(
      "in_progress",
    );
  });

  test("ui_show fills well-formed templateData for a stepless task_progress card", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Researching",
      template: "task_progress",
      data: {},
    });

    expect(result.isError).toBe(false);

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    );
    expect(showMessage).toBeDefined();
    if (!showMessage || showMessage.surfaceType !== "card") return;

    const card = showMessage.data as CardSurfaceData;
    expect(card.template).toBe("task_progress");
    const templateData = card.templateData as Record<string, unknown>;
    expect(templateData.status).toBe("in_progress");
    expect(templateData.title).toBe("Researching");
    expect(templateData.steps).toEqual([]);
  });

  test("ui_show coerces invalid status and malformed steps on a task_progress card", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Building",
      template: "task_progress",
      templateData: {
        status: "working",
        steps: [
          { label: "Valid step" },
          { title: "Aliased label", status: "completed" },
          { status: "in_progress" },
          "not an object",
        ],
      },
    });

    expect(result.isError).toBe(false);

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    );
    expect(showMessage).toBeDefined();
    if (!showMessage || showMessage.surfaceType !== "card") return;

    const templateData = (showMessage.data as CardSurfaceData)
      .templateData as Record<string, unknown>;
    expect(templateData.status).toBe("in_progress");
    const steps = templateData.steps as Array<Record<string, unknown>>;
    expect(steps).toHaveLength(2);
    expect(steps[0]).toEqual({ label: "Valid step", status: "pending" });
    expect(steps[1]).toEqual({
      title: "Aliased label",
      label: "Aliased label",
      status: "completed",
    });
  });

  test("ui_show normalizes top-level dynamic_page fields into data", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "dynamic_page",
      title: "My Slides",
      html: "<h1>Hello</h1>",
      preview: { title: "Slides", subtitle: "3 slides about Apple" },
    });

    expect(result.isError).toBe(false);

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    );
    expect(showMessage).toBeDefined();
    if (!showMessage || showMessage.surfaceType !== "dynamic_page") return;

    const page = showMessage.data as DynamicPageSurfaceData;
    expect(page.html).toBe("<h1>Hello</h1>");
    expect(page.preview).toEqual({
      title: "Slides",
      subtitle: "3 slides about Apple",
    });
  });

  test("ui_show supports file_upload surfaces directly", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "file_upload",
      title: "Upload a receipt",
      data: {
        prompt: "Share the receipt PDF",
        acceptedTypes: ["application/pdf"],
        maxFiles: 1,
      },
    });

    expect(result.isError).toBe(false);
    expect(result.yieldToUser).toBe(true);

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    );
    expect(showMessage).toBeDefined();
    if (!showMessage || showMessage.surfaceType !== "file_upload") return;

    expect(showMessage.title).toBe("Upload a receipt");
    expect(showMessage.data).toEqual({
      prompt: "Share the receipt PDF",
      acceptedTypes: ["application/pdf"],
      maxFiles: 1,
    });
    expect(ctx.pendingSurfaceActions.get(showMessage.surfaceId)).toEqual({
      surfaceType: "file_upload",
    });
  });

  test("ui_show file_upload normalizes a comma-joined acceptedTypes string", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    // The model may emit acceptedTypes as a comma-joined string; the renderer
    // calls `.join`/`.some` on it, so the daemon hands the client a clean array.
    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "file_upload",
      title: "Upload a receipt",
      data: {
        prompt: "Share the receipt",
        acceptedTypes: "image/*, application/pdf",
      },
    });

    expect(result.isError).toBe(false);

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    );
    expect(showMessage).toBeDefined();
    if (!showMessage || showMessage.surfaceType !== "file_upload") return;

    expect(showMessage.data.acceptedTypes).toEqual([
      "image/*",
      "application/pdf",
    ]);
  });

  test("ui_show dynamic_page uses data.html when properly nested", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "dynamic_page",
      title: "My Slides",
      data: { html: "<h1>Nested</h1>" },
    });

    expect(result.isError).toBe(false);

    const showMessage = sent.find(
      (msg): msg is UiSurfaceShow => msg.type === "ui_surface_show",
    );
    expect(showMessage).toBeDefined();
    if (!showMessage || showMessage.surfaceType !== "dynamic_page") return;

    const page = showMessage.data as DynamicPageSurfaceData;
    expect(page.html).toBe("<h1>Nested</h1>");
  });

  test("ui_update normalizes top-level task_progress fields into templateData", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);
    const existingCard: CardSurfaceData = {
      title: "Ordering from DoorDash",
      body: "",
      template: "task_progress",
      templateData: {
        title: "Ordering from DoorDash",
        status: "in_progress",
        steps: [
          { label: "Search restaurants", status: "completed" },
          { label: "Browse menu", status: "in_progress" },
          { label: "Add to cart", status: "pending" },
        ],
      },
    };

    ctx.surfaceState.set("surface-1", {
      surfaceType: "card",
      data: existingCard,
    });

    const result = await surfaceProxyResolver(ctx, "ui_update", {
      surface_id: "surface-1",
      data: {
        status: "completed",
      },
    });

    expect(result.isError).toBe(false);

    const updateMessage = sent.find(
      (msg): msg is UiSurfaceUpdate => msg.type === "ui_surface_update",
    );
    expect(updateMessage).toBeDefined();
    if (!updateMessage) return;

    const updatedCard = updateMessage.data as CardSurfaceData &
      Record<string, unknown>;
    expect(updatedCard.template).toBe("task_progress");
    expect("status" in updatedCard).toBe(false);
    const templateData = updatedCard.templateData as Record<string, unknown>;
    expect(templateData.status).toBe("completed");
    expect(Array.isArray(templateData.steps)).toBe(true);
  });

  test("allows Slack ui_update for stored task_progress card when dynamic UI is disabled", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent, {
      channel: "slack",
      supportsDynamicUi: false,
    });
    ctx.surfaceState.set("surface-1", {
      surfaceType: "card",
      data: {
        title: "Working",
        body: "",
        template: "task_progress",
        templateData: { status: "in_progress", steps: [] },
      } satisfies CardSurfaceData,
    });

    const result = await surfaceProxyResolver(ctx, "ui_update", {
      surface_id: "surface-1",
      data: { status: "completed" },
    });

    expect(result.isError).toBe(false);
    const updateMessage = sent.find(
      (msg): msg is UiSurfaceUpdate => msg.type === "ui_surface_update",
    );
    expect(updateMessage).toBeDefined();
    if (!updateMessage) return;
    const templateData = (updateMessage.data as CardSurfaceData)
      .templateData as Record<string, unknown>;
    expect(templateData.status).toBe("completed");
  });

  test("blocks Slack ui_update when stored surface is not a task_progress card", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent, {
      channel: "slack",
      supportsDynamicUi: false,
    });
    ctx.surfaceState.set("surface-1", {
      surfaceType: "card",
      data: { title: "Plain", body: "No progress" } satisfies CardSurfaceData,
    });

    const result = await surfaceProxyResolver(ctx, "ui_update", {
      surface_id: "surface-1",
      data: { body: "still blocked" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'ui_update is unavailable on channel "slack"',
    );
    expect(sent).toHaveLength(0);
  });

  test("blocks Slack ui_update that would convert a plain card to task_progress", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent, {
      channel: "slack",
      supportsDynamicUi: false,
    });
    ctx.surfaceState.set("surface-1", {
      surfaceType: "card",
      data: { title: "Plain", body: "No progress" } satisfies CardSurfaceData,
    });

    const result = await surfaceProxyResolver(ctx, "ui_update", {
      surface_id: "surface-1",
      data: {
        template: "task_progress",
        templateData: { status: "in_progress", steps: [] },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'ui_update is unavailable on channel "slack"',
    );
    expect(sent).toHaveLength(0);
  });

  test("blocks Slack ui_update that would change task_progress card template", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent, {
      channel: "slack",
      supportsDynamicUi: false,
    });
    ctx.surfaceState.set("surface-1", {
      surfaceType: "card",
      data: {
        title: "Working",
        body: "",
        template: "task_progress",
        templateData: { status: "in_progress", steps: [] },
      } satisfies CardSurfaceData,
    });

    const result = await surfaceProxyResolver(ctx, "ui_update", {
      surface_id: "surface-1",
      data: { template: "plain", body: "now a plain card" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'ui_update is unavailable on channel "slack"',
    );
    expect(sent).toHaveLength(0);
    expect(
      (ctx.surfaceState.get("surface-1")?.data as CardSurfaceData).template,
    ).toBe("task_progress");
  });

  test("blocks Slack ui_update when the surface is not already stored", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent, {
      channel: "slack",
      supportsDynamicUi: false,
    });

    const result = await surfaceProxyResolver(ctx, "ui_update", {
      surface_id: "missing-surface",
      data: { status: "completed" },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      'ui_update is unavailable on channel "slack"',
    );
    expect(sent).toHaveLength(0);
  });

  test("ui_show rejects new interactive surface when a non-dynamic_page pending surface exists", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    // Pre-populate a pending table surface (simulates a previously shown interactive surface)
    ctx.pendingSurfaceActions.set("stale-surface-1", { surfaceType: "table" });

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "table",
      title: "New Table",
      data: { columns: [], rows: [] },
      actions: [{ id: "archive", label: "Archive" }],
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "Another interactive surface is already awaiting user input",
    );
    // The stale entry should still be present (guard only rejects, doesn't clean up)
    expect(ctx.pendingSurfaceActions.has("stale-surface-1")).toBe(true);
  });

  test("ui_show allows new interactive surface when only dynamic_page surfaces are pending", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    // dynamic_page pending entries should not block new interactive surfaces
    ctx.pendingSurfaceActions.set("page-1", { surfaceType: "dynamic_page" });

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "table",
      title: "Email Table",
      data: { columns: [], rows: [] },
      actions: [{ id: "archive", label: "Archive" }],
    });

    expect(result.isError).toBe(false);
    expect(sent.some((m) => m.type === "ui_surface_show")).toBe(true);
  });
});

describe("ui_show card content recovery", () => {
  function shownCard(sent: ServerMessage[]): CardSurfaceData | undefined {
    const show = sent.find(
      (m): m is UiSurfaceShow => m.type === "ui_surface_show",
    );
    if (!show || show.surfaceType !== "card") return undefined;
    return show.data;
  }

  test("recovers body from a copy_block-style `text` field", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Inbox cleaned",
      data: { text: "Archived 1,240 emails" },
    });

    expect(result.isError).toBe(false);
    const card = shownCard(sent);
    expect(card?.body).toBe("Archived 1,240 emails");
    // The alias key is not a card field; it must not survive on the surface.
    expect((card as Record<string, unknown>).text).toBeUndefined();
  });

  test("recovers body from a confirmation-style `message` field", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      data: { title: "Heads up", message: "The server will restart." },
    });

    expect(shownCard(sent)?.body).toBe("The server will restart.");
  });

  test("recovers top-level subtitle and metadata into the card", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      subtitle: "saved just now",
      metadata: [{ label: "Total", value: "$10" }],
      data: { body: "Done" },
    });

    const card = shownCard(sent);
    expect(card?.subtitle).toBe("saved just now");
    expect(card?.metadata).toEqual([{ label: "Total", value: "$10" }]);
  });

  test("title-only card with actions renders with actions intact", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Restart the server?",
      actions: [{ id: "yes", label: "Yes" }],
      data: {},
    });

    expect(result.isError).toBe(false);
    expect(shownCard(sent)?.title).toBe("Restart the server?");
    const show = sent.find(
      (m): m is UiSurfaceShow => m.type === "ui_surface_show",
    )!;
    expect(show.actions).toBeDefined();
    expect(show.actions!.length).toBe(1);
    expect(show.actions![0].label).toBe("Yes");
  });

  test("title-only card without actions renders without error", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Status update",
      data: {},
    });

    expect(result.isError).toBe(false);
    expect(shownCard(sent)?.title).toBe("Status update");
  });

  test("card with body and actions is interactive", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Confirm",
      actions: [{ id: "ok", label: "OK" }],
      data: { body: "Are you sure?" },
    });

    expect(result.isError).toBe(false);
    const show = sent.find(
      (m): m is UiSurfaceShow => m.type === "ui_surface_show",
    )!;
    expect(show.actions).toBeDefined();
    expect(show.actions!.length).toBe(1);
  });

  // ── Body alias recovery from cross-surface keys ────────────────────

  test("recovers body from choice/form-style `description` field", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Search results",
      data: { description: "Found 12 matching documents." },
    });

    const card = shownCard(sent);
    expect(card?.body).toBe("Found 12 matching documents.");
    expect((card as Record<string, unknown>).description).toBeUndefined();
  });

  test("recovers body from work_result-style `summary` field", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      data: { title: "Report", summary: "All tests passed." },
    });

    expect(shownCard(sent)?.body).toBe("All tests passed.");
  });

  test("recovers body from confirmation-style `detail` field", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      data: { title: "Warning", detail: "This action cannot be undone." },
    });

    expect(shownCard(sent)?.body).toBe("This action cannot be undone.");
  });

  test("recovers body from top-level `description`", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Info",
      description: "Top-level description text",
      data: {},
    });

    expect(shownCard(sent)?.body).toBe("Top-level description text");
  });

  test("concatenates multiple body aliases when they co-occur", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Multi-alias",
      data: {
        description: "Found 12 documents.",
        summary: "Search complete.",
        detail: "Checked 3 sources.",
      },
    });

    const body = shownCard(sent)?.body;
    expect(body).toContain("Found 12 documents.");
    expect(body).toContain("Search complete.");
    expect(body).toContain("Checked 3 sources.");
  });

  // ── Title alias recovery ────────────────────────────────────────────

  test("recovers title from `heading` alias", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      data: { heading: "Results", body: "Done." },
    });

    expect(shownCard(sent)?.title).toBe("Results");
  });

  test("recovers title from `header` alias", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      data: { header: "Status Update", body: "All good." },
    });

    expect(shownCard(sent)?.title).toBe("Status Update");
  });

  // ── Subtitle alias recovery ─────────────────────────────────────────

  test("recovers subtitle from `subheading` alias", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      data: { title: "Alert", body: "Check this.", subheading: "Important" },
    });

    expect(shownCard(sent)?.subtitle).toBe("Important");
  });

  test("recovers subtitle from table-style `caption` alias", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      data: { title: "Table Summary", body: "Data below.", caption: "Q4 2024" },
    });

    expect(shownCard(sent)?.subtitle).toBe("Q4 2024");
  });

  // ── Alias precedence ───────────────────────────────────────────────

  test("canonical `body` takes precedence over aliased `description`", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      data: { body: "Real body", description: "Should be ignored" },
    });

    expect(shownCard(sent)?.body).toBe("Real body");
  });

  test("card with recovered `description` and actions keeps actions (has content)", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Confirm",
      actions: [{ id: "ok", label: "OK" }],
      data: { description: "Proceed with deployment?" },
    });

    expect(result.isError).toBe(false);
    const show = sent.find(
      (m): m is UiSurfaceShow => m.type === "ui_surface_show",
    )!;
    expect(show.actions).toBeDefined();
    expect(shownCard(sent)?.body).toBe("Proceed with deployment?");
  });

  test("recovers actions nested inside data when top-level actions is absent", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Confirm deployment",
      data: {
        body: "Deploy to production?",
        actions: [{ id: "yes", label: "Yes" }],
      },
    });

    expect(result.isError).toBe(false);
    const show = sent.find(
      (m): m is UiSurfaceShow => m.type === "ui_surface_show",
    )!;
    expect(show.actions).toBeDefined();
    expect(show.actions!.length).toBe(1);
    expect(show.actions![0].label).toBe("Yes");
  });

  test("top-level actions take precedence over data.actions", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      title: "Confirm",
      actions: [{ id: "top", label: "Top-level" }],
      data: {
        body: "Which actions?",
        actions: [{ id: "nested", label: "Nested" }],
      },
    });

    const show = sent.find(
      (m): m is UiSurfaceShow => m.type === "ui_surface_show",
    )!;
    expect(show.actions!.length).toBe(1);
    expect(show.actions![0].label).toBe("Top-level");
  });

  test("genuinely empty card (no title, body, subtitle, metadata, template, or actions) is rejected", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      data: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires content");
    expect(sent.filter((m) => m.type === "ui_surface_show")).toHaveLength(0);
  });

  test("a card with a real body broadcasts unchanged", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      data: { title: "Plain", body: "hi" },
    });

    expect(shownCard(sent)?.body).toBe("hi");
  });

  test("a task_progress card with empty data broadcasts (template renders a shell)", async () => {
    const sent: ServerMessage[] = [];
    const ctx = makeContext(sent);

    const result = await surfaceProxyResolver(ctx, "ui_show", {
      surface_type: "card",
      template: "task_progress",
      templateData: { status: "in_progress", steps: [] },
    });

    expect(result.isError).toBe(false);
    expect(shownCard(sent)?.template).toBe("task_progress");
  });
});
