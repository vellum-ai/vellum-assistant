import { v4 as uuid } from "uuid";

import {
  getApp,
  getAppPreview,
  resolveAppDir,
  updateApp,
} from "../memory/app-store.js";
import type { ToolExecutionResult } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import { isPlainObject } from "../util/object.js";
import { buildConversationErrorMessage } from "./conversation-error.js";
import type {
  CardSurfaceData,
  DynamicPageSurfaceData,
  ListSurfaceData,
  ServerMessage,
  SurfaceData,
  SurfaceType,
  TableColumn,
  TableRow,
  TableSurfaceData,
  UiSurfaceShow,
} from "./message-protocol.js";
import { INTERACTIVE_SURFACE_TYPES } from "./message-protocol.js";

const log = getLogger("conversation-surfaces");

const MAX_UNDO_DEPTH = 10;
const TASK_PROGRESS_TEMPLATE_FIELDS = ["title", "status", "steps"] as const;

/**
 * Migrate dynamic_page fields from the top-level tool input into `data`.
 *
 * The LLM sometimes sends `html`, `width`, `height`, or `preview` at the
 * top level instead of nested inside `data`. Without this normalization the
 * surface opens blank because `rawData` is `{}`.
 */
function normalizeDynamicPageShowData(
  input: Record<string, unknown>,
  rawData: Record<string, unknown>,
): DynamicPageSurfaceData {
  const normalized: Record<string, unknown> = { ...rawData };

  if (typeof normalized.html !== "string" && typeof input.html === "string") {
    normalized.html = input.html;
  }
  if (normalized.width == null && input.width != null) {
    normalized.width = input.width;
  }
  if (normalized.height == null && input.height != null) {
    normalized.height = input.height;
  }
  if (!isPlainObject(normalized.preview) && isPlainObject(input.preview)) {
    normalized.preview = input.preview;
  }

  return normalized as unknown as DynamicPageSurfaceData;
}

function normalizeCardShowData(
  input: Record<string, unknown>,
  rawData: Record<string, unknown>,
): CardSurfaceData {
  const normalized: Record<string, unknown> = { ...rawData };

  // Older prompt examples sent template/templateData at the top level.
  if (
    typeof normalized.template !== "string" &&
    typeof input.template === "string"
  ) {
    normalized.template = input.template;
  }
  if (
    !isPlainObject(normalized.templateData) &&
    isPlainObject(input.templateData)
  ) {
    normalized.templateData = input.templateData;
  }

  // The LLM sometimes sends `title` or `body` at the top-level tool input
  // instead of nesting them inside `data`. The Swift client requires `title`
  // inside the card data dict — without it `parseCardData` returns nil and
  // the surface is silently dropped. Copy them from input when missing.
  if (
    typeof normalized.title !== "string" &&
    typeof input.title === "string" &&
    input.title.trim().length > 0
  ) {
    normalized.title = input.title;
  }
  if (typeof normalized.body !== "string" && typeof input.body === "string") {
    normalized.body = input.body;
  }

  // task_progress cards: additional fallbacks for title from templateData.
  if (
    normalized.template === "task_progress" &&
    typeof normalized.title !== "string"
  ) {
    if (
      isPlainObject(normalized.templateData) &&
      typeof normalized.templateData.title === "string"
    ) {
      normalized.title = normalized.templateData.title;
    } else {
      normalized.title = "Task Progress";
    }
  }

  if (
    normalized.template === "task_progress" &&
    typeof normalized.body !== "string"
  ) {
    normalized.body = "";
  }

  return normalized as unknown as CardSurfaceData;
}

function normalizeTaskProgressCardPatch(
  existingCard: CardSurfaceData,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  if (existingCard.template !== "task_progress") {
    return patch;
  }

  const normalizedPatch: Record<string, unknown> = { ...patch };
  const mergedTemplateData: Record<string, unknown> = isPlainObject(
    existingCard.templateData,
  )
    ? { ...existingCard.templateData }
    : {};

  let updatedTemplateData = false;

  if (isPlainObject(normalizedPatch.templateData)) {
    Object.assign(mergedTemplateData, normalizedPatch.templateData);
    updatedTemplateData = true;
  }

  // Accept top-level task_progress fields from older prompt examples and
  // move them into templateData where the Swift client expects them.
  for (const key of TASK_PROGRESS_TEMPLATE_FIELDS) {
    if (key in normalizedPatch) {
      mergedTemplateData[key] = normalizedPatch[key];
      delete normalizedPatch[key];
      updatedTemplateData = true;
    }
  }

  if (updatedTemplateData) {
    normalizedPatch.templateData = mergedTemplateData;
  }

  return normalizedPatch;
}

/**
 * Subset of Conversation state that surface helpers need access to.
 * The Conversation class implements this interface so its instances can be
 * passed directly to the extracted functions.
 */
export interface SurfaceConversationContext {
  readonly conversationId: string;
  readonly channelCapabilities?: {
    channel: string;
    supportsDynamicUi: boolean;
  };
  readonly traceEmitter: {
    emit(type: string, message: string, meta?: Record<string, unknown>): void;
  };
  sendToClient(msg: ServerMessage): void;
  broadcastToAllClients?(msg: ServerMessage): void;
  pendingSurfaceActions: Map<string, { surfaceType: SurfaceType }>;
  lastSurfaceAction: Map<
    string,
    { actionId: string; data?: Record<string, unknown> }
  >;
  surfaceState: Map<
    string,
    {
      surfaceType: SurfaceType;
      data: SurfaceData;
      title?: string;
      actions?: Array<{
        id: string;
        label: string;
        style?: string;
        data?: Record<string, unknown>;
      }>;
    }
  >;
  surfaceUndoStacks: Map<string, string[]>;
  accumulatedSurfaceState: Map<string, Record<string, unknown>>;
  /** Request IDs that originated from surface action button clicks (not regular user messages). */
  surfaceActionRequestIds: Set<string>;
  currentTurnSurfaces: Array<{
    surfaceId: string;
    surfaceType: SurfaceType;
    title?: string;
    data: SurfaceData;
    actions?: Array<{
      id: string;
      label: string;
      style?: string;
      data?: Record<string, unknown>;
    }>;
    display?: string;
  }>;
  /** Optional proxy for delegating computer-use actions to a connected desktop client. */
  hostCuProxy?: import("./host-cu-proxy.js").HostCuProxy;
  isProcessing(): boolean;
  enqueueMessage(
    content: string,
    attachments: never[],
    onEvent: (msg: ServerMessage) => void,
    requestId: string,
    activeSurfaceId?: string,
    currentPage?: string,
    metadata?: Record<string, unknown>,
    options?: { isInteractive?: boolean },
    displayContent?: string,
  ): { queued: boolean; requestId: string; rejected?: boolean };
  getQueueDepth(): number;
  processMessage(
    content: string,
    attachments: never[],
    onEvent: (msg: ServerMessage) => void,
    requestId?: string,
    activeSurfaceId?: string,
    currentPage?: string,
    options?: { isInteractive?: boolean },
    displayContent?: string,
  ): Promise<string>;
  /** Serialize operations on a given surface to prevent read-modify-write races. */
  withSurface<T>(surfaceId: string, fn: () => T | Promise<T>): Promise<T>;
}

export type SurfaceMutex = {
  <T>(surfaceId: string, fn: () => T | Promise<T>): Promise<T>;
  /** Number of surfaces with an active chain — exposed for tests. */
  readonly size: number;
};

/**
 * Per-surface async mutex using Promise chaining.
 * Operations on the same surfaceId are serialized; different surfaces run concurrently.
 */
export function createSurfaceMutex(): SurfaceMutex {
  const chains = new Map<string, Promise<void>>();

  const mutex = <T>(
    surfaceId: string,
    fn: () => T | Promise<T>,
  ): Promise<T> => {
    const prev = chains.get(surfaceId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the chain alive but swallow errors so one failure doesn't block subsequent ops
    const tail = next.then(
      () => {},
      () => {},
    );
    chains.set(surfaceId, tail);
    // Clean up the map entry once the queue settles to prevent unbounded growth
    tail.then(() => {
      if (chains.get(surfaceId) === tail) {
        chains.delete(surfaceId);
      }
    });
    return next;
  };

  Object.defineProperty(mutex, "size", { get: () => chains.size });
  return mutex as SurfaceMutex;
}

/**
 * Handle content_changed action from document editor.
 * Auto-saves the document content to the app store.
 */
function handleDocumentContentChanged(
  ctx: SurfaceConversationContext,
  surfaceId: string,
  data?: Record<string, unknown>,
): void {
  if (!data) {
    log.warn({ surfaceId }, "content_changed action missing data");
    return;
  }

  const { title, content, wordCount } = data as {
    title?: string;
    content?: string;
    wordCount?: number;
  };

  if (!title && !content) {
    log.warn({ surfaceId }, "content_changed action missing title or content");
    return;
  }

  // Find the app ID from the surface state
  const surfaceState = ctx.surfaceState.get(surfaceId);
  if (!surfaceState || surfaceState.surfaceType !== "dynamic_page") {
    log.warn({ surfaceId }, "Surface not found or not a dynamic page");
    return;
  }

  const dynamicPageData = surfaceState.data as DynamicPageSurfaceData;
  const appId = dynamicPageData.appId;

  if (!appId || !appId.startsWith("doc-")) {
    // Not a document app, ignore
    log.debug({ surfaceId, appId }, "Not a document app, skipping auto-save");
    return;
  }

  try {
    const app = getApp(appId);
    if (!app) {
      log.warn({ appId }, "Document app not found");
      return;
    }

    // Regenerate the editor HTML with updated content
    // We need to import the editor template dynamically
    import("../tools/document/editor-template.js")
      .then(({ generateEditorHTML }) => {
        const updatedHtml = generateEditorHTML(
          title || app.name,
          content || "",
        );

        updateApp(appId, {
          name: title || app.name,
          description: `Document with ${wordCount ?? 0} words`,
          preview: content?.slice(0, 200),
          htmlDefinition: updatedHtml,
        });

        log.info({ appId, wordCount }, "Document auto-saved");
      })
      .catch((err) => {
        log.error(
          { err, appId },
          "Failed to import editor template for auto-save",
        );
      });
  } catch (err) {
    log.error({ err, appId }, "Failed to auto-save document");
  }
}

/**
 * Handle state_update action from a dynamic page.
 * Accumulates state via shallow merge without triggering an LLM turn.
 */
function handleStateUpdate(
  ctx: SurfaceConversationContext,
  surfaceId: string,
  data?: Record<string, unknown>,
): void {
  if (!data) {
    log.debug({ surfaceId }, "state_update action called with no data");
    return;
  }

  const surfaceState = ctx.surfaceState.get(surfaceId);
  if (!surfaceState || surfaceState.surfaceType !== "dynamic_page") {
    log.warn(
      { surfaceId, surfaceType: surfaceState?.surfaceType },
      "state_update action received for non-dynamic_page surface",
    );
    return;
  }

  const existing = ctx.accumulatedSurfaceState.get(surfaceId) ?? {};
  const merged = { ...existing, ...data };
  ctx.accumulatedSurfaceState.set(surfaceId, merged);

  log.debug(
    { surfaceId, accumulatedState: merged },
    "Accumulated surface state updated",
  );
}

export function pushUndoState(
  surfaceUndoStacks: Map<string, string[]>,
  surfaceId: string,
  html: string,
): void {
  let stack = surfaceUndoStacks.get(surfaceId);
  if (!stack) {
    stack = [];
    surfaceUndoStacks.set(surfaceId, stack);
  }
  stack.push(html);
  if (stack.length > MAX_UNDO_DEPTH) {
    stack.shift();
  }
}

export function handleSurfaceUndo(
  ctx: SurfaceConversationContext,
  surfaceId: string,
): void {
  const stack = ctx.surfaceUndoStacks.get(surfaceId);
  if (!stack || stack.length === 0) {
    ctx.sendToClient({
      type: "ui_surface_undo_result",
      conversationId: ctx.conversationId,
      surfaceId,
      success: false,
      remainingUndos: 0,
    });
    return;
  }

  const previousHtml = stack.pop()!;
  const stored = ctx.surfaceState.get(surfaceId);
  if (!stored || stored.surfaceType !== "dynamic_page") {
    ctx.sendToClient({
      type: "ui_surface_undo_result",
      conversationId: ctx.conversationId,
      surfaceId,
      success: false,
      remainingUndos: stack.length,
    });
    return;
  }

  const data = stored.data as DynamicPageSurfaceData;

  // If app-backed, also revert the persisted app and refresh all surfaces for this app
  if (data.appId) {
    try {
      updateApp(data.appId, { htmlDefinition: previousHtml });
    } catch (err) {
      log.error({ appId: data.appId, err }, "Failed to revert app during undo");
    }

    // Update ALL surfaces that share this appId (not just the requesting one)
    for (const [sid, s] of ctx.surfaceState.entries()) {
      if (s.surfaceType !== "dynamic_page") continue;
      const sData = s.data as DynamicPageSurfaceData;
      if (sData.appId !== data.appId) continue;
      const revertedData: DynamicPageSurfaceData = {
        ...sData,
        html: previousHtml,
      };
      s.data = revertedData;
      ctx.sendToClient({
        type: "ui_surface_update",
        conversationId: ctx.conversationId,
        surfaceId: sid,
        data: revertedData,
      });
    }

    // Sync sibling undo stacks: pop the top entry if it matches the HTML we
    // just reverted to, preventing phantom no-op undo steps on siblings.
    for (const [sid, s] of ctx.surfaceState.entries()) {
      if (sid === surfaceId) continue;
      if (s.surfaceType !== "dynamic_page") continue;
      const sData = s.data as DynamicPageSurfaceData;
      if (sData.appId !== data.appId) continue;

      const siblingStack = ctx.surfaceUndoStacks.get(sid);
      if (siblingStack && siblingStack.length > 0) {
        const top = siblingStack[siblingStack.length - 1];
        if (top === previousHtml) {
          siblingStack.pop();
        }
      }
    }
  } else {
    // Ephemeral surface — update only the requesting surface
    const revertedData: DynamicPageSurfaceData = {
      ...data,
      html: previousHtml,
    };
    stored.data = revertedData;
    ctx.sendToClient({
      type: "ui_surface_update",
      conversationId: ctx.conversationId,
      surfaceId,
      data: revertedData,
    });
  }

  ctx.sendToClient({
    type: "ui_surface_undo_result",
    conversationId: ctx.conversationId,
    surfaceId,
    success: true,
    remainingUndos: stack.length,
  });

  log.info(
    { conversationId: ctx.conversationId, surfaceId, remaining: stack.length },
    "Surface undo applied",
  );
}

/** Extract a human-readable label from a table row using the first column value. */
export function describeTableRow(
  row: TableRow,
  columns: TableColumn[],
): string {
  if (columns.length === 0) return row.id;
  const firstColId = columns[0].id;
  const cell = row.cells[firstColId];
  if (cell == null) return row.id;
  if (typeof cell === "string") return cell;
  return cell.text;
}

const MAX_DESELECTION_ITEMS = 20;

/** Format a list of deselected item labels as a bullet list, capped at MAX_DESELECTION_ITEMS. */
export function formatDeselectionList(labels: string[]): string {
  if (labels.length === 0) return "";
  const shown = labels.slice(0, MAX_DESELECTION_ITEMS);
  const lines = shown.map((l) => `- ${l}`);
  if (labels.length > MAX_DESELECTION_ITEMS) {
    lines.push(`(and ${labels.length - MAX_DESELECTION_ITEMS} more)`);
  }
  return lines.join("\n");
}

/**
 * Compute a deselection description by diffing selectedIds against the stored
 * surface state rows/items. Returns empty string when nothing was deselected.
 */
export function buildDeselectionDescription(
  surfaceType: SurfaceType,
  surfaceState: { surfaceType: SurfaceType; data: SurfaceData } | undefined,
  selectedIds: string[],
): string {
  if (!surfaceState) return "";
  const selectedSet = new Set(selectedIds);

  if (surfaceType === "table" && surfaceState.surfaceType === "table") {
    const tableData = surfaceState.data as TableSurfaceData;
    const deselectedLabels: string[] = [];
    for (const row of tableData.rows) {
      if (row.selectable === false) continue;
      if (!selectedSet.has(row.id)) {
        deselectedLabels.push(describeTableRow(row, tableData.columns));
      }
    }
    if (deselectedLabels.length === 0) return "";
    return `\n\nDeselected items (user chose NOT to include):\n${formatDeselectionList(
      deselectedLabels,
    )}`;
  }

  if (surfaceType === "list" && surfaceState.surfaceType === "list") {
    const listData = surfaceState.data as ListSurfaceData;
    const deselectedLabels: string[] = [];
    for (const item of listData.items) {
      if (!selectedSet.has(item.id)) {
        deselectedLabels.push(item.title);
      }
    }
    if (deselectedLabels.length === 0) return "";
    return `\n\nDeselected items (user chose NOT to include):\n${formatDeselectionList(
      deselectedLabels,
    )}`;
  }

  return "";
}

export function handleSurfaceAction(
  ctx: SurfaceConversationContext,
  surfaceId: string,
  actionId: string,
  data?: Record<string, unknown>,
): void {
  const pending = ctx.pendingSurfaceActions.get(surfaceId);

  // When surfaces are restored from history (e.g. onboarding cards), there is
  // no in-memory pendingSurfaceActions entry.  Handle non-terminal actions
  // directly, and forward custom/relay actions to the LLM.
  if (!pending) {
    // Non-terminal actions don't need stored state — handle directly.
    if (actionId === "selection_changed") {
      log.debug(
        { surfaceId, data },
        "Selection changed (history-restored, not forwarding)",
      );
      return;
    }
    if (actionId === "content_changed") {
      log.debug(
        { surfaceId },
        "Content changed (history-restored, no surface state — skipping)",
      );
      return;
    }
    if (actionId === "state_update") {
      if (data) {
        const existing = ctx.accumulatedSurfaceState.get(surfaceId) ?? {};
        ctx.accumulatedSurfaceState.set(surfaceId, { ...existing, ...data });
      }
      log.debug(
        { surfaceId, data },
        "Silent state accumulated (history-restored)",
      );
      return;
    }

    // Determine message content from the action.
    const isRelay = actionId === "relay_prompt" || actionId === "agent_prompt";
    const prompt =
      isRelay && typeof data?.prompt === "string" ? data.prompt.trim() : "";

    // Read accumulated state once — used by both relay and custom action paths.
    const accState = ctx.accumulatedSurfaceState.get(surfaceId);
    const hasAccState = accState && Object.keys(accState).length > 0;

    let content: string;
    let displayContent: string | undefined;
    if (prompt) {
      content = prompt;
      // Re-append accumulated state so the LLM sees it, matching the pending path.
      if (hasAccState) {
        content += `\n\nAccumulated surface state: ${JSON.stringify(accState)}`;
      }
    } else {
      // Custom action from an app (e.g. sendAction('answer_selected', {...}))
      const summary = actionId
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
      content = `[User action on app: ${summary}]`;
      if (data && Object.keys(data).length > 0) {
        content += `\n\nAction data: ${JSON.stringify(data)}`;
      }
      if (hasAccState) {
        content += `\n\nAccumulated surface state: ${JSON.stringify(accState)}`;
      }
      displayContent = summary;
    }

    const requestId = uuid();
    ctx.surfaceActionRequestIds.add(requestId);
    // Use broadcastToAllClients (publishes to the SSE event hub) instead of
    // sendToClient, which is reset to a no-op between HTTP requests. Without
    // this, surface action responses are persisted to DB but never reach the
    // client's SSE stream.
    const emit = ctx.broadcastToAllClients ?? ctx.sendToClient.bind(ctx);
    const onEvent = (msg: ServerMessage) => emit(msg);

    ctx.traceEmitter.emit("request_received", "Surface action received", {
      requestId,
      status: "info",
      attributes: { source: "surface_action", surfaceId, actionId },
    });

    const result = ctx.enqueueMessage(
      content,
      [],
      onEvent,
      requestId,
      surfaceId,
      undefined,
      undefined,
      undefined,
      displayContent,
    );

    if (result.rejected) {
      ctx.surfaceActionRequestIds.delete(requestId);
      return;
    }

    // One-shot: clear accumulated state now that the message has been accepted.
    // Deferred until after rejection check so state is preserved for retry on rejection.
    if (hasAccState) {
      ctx.accumulatedSurfaceState.delete(surfaceId);
    }

    // Echo the prompt to the client so it appears in the chat UI.
    // Deferred until after rejection check to avoid ghost messages.
    if (prompt) {
      emit({
        type: "user_message_echo",
        text: prompt,
        conversationId: ctx.conversationId,
      });
    }

    if (result.queued) {
      log.info(
        { surfaceId, actionId, requestId },
        "Surface action queued (conversation busy, history-restored)",
      );
      return;
    }

    // Conversation is idle — process the message immediately.
    log.info(
      { surfaceId, actionId, requestId },
      "Processing surface action immediately (history-restored)",
    );
    ctx
      .processMessage(
        content,
        [],
        onEvent,
        requestId,
        surfaceId,
        undefined,
        undefined,
        displayContent,
      )
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error(
          { err, surfaceId, actionId },
          "Failed to process history-restored surface action",
        );
        onEvent(
          buildConversationErrorMessage(ctx.conversationId, {
            code: "CONVERSATION_PROCESSING_FAILED",
            userMessage: `Something went wrong: ${message}`,
            retryable: false,
            debugDetails: `History-restored surface action processing failed: ${message}`,
            errorCategory: "processing_failed",
          }),
        );
      });
    return;
  }
  const retainPending = pending.surfaceType === "dynamic_page";
  // selection_changed is a non-terminal state update — don't consume the
  // pending entry or send a message.
  if (actionId === "selection_changed") {
    log.debug(
      { surfaceId, data },
      "Selection changed (non-terminal, not forwarding)",
    );
    return;
  }

  // content_changed is a non-terminal state update for document auto-save
  // Save the document content and don't forward to the conversation
  if (actionId === "content_changed") {
    handleDocumentContentChanged(ctx, surfaceId, data);
    return;
  }

  // state_update is a silent accumulation action — merge data into accumulated
  // state without triggering an LLM turn.
  if (actionId === "state_update") {
    handleStateUpdate(ctx, surfaceId, data);
    return;
  }

  // Merge stored action-level data (from ui_show definition) with client-sent
  // data. This is critical for relay_prompt buttons: the client only sends the
  // actionId, but the prompt payload lives in the action definition's data.
  const stored = ctx.surfaceState.get(surfaceId);
  const actionDef = stored?.actions?.find((a) => a.id === actionId);
  const mergedData: Record<string, unknown> | undefined =
    actionDef?.data || data ? { ...actionDef?.data, ...data } : undefined;

  ctx.lastSurfaceAction.set(surfaceId, { actionId, data: mergedData });
  const shouldRelayPrompt =
    actionId === "relay_prompt" || actionId === "agent_prompt";
  const prompt =
    shouldRelayPrompt && typeof mergedData?.prompt === "string"
      ? mergedData.prompt.trim()
      : "";

  // Build a human-readable summary so the LLM clearly understands the
  // user's decision instead of parsing raw JSON.
  const surfaceData = stored?.data as Record<string, unknown> | undefined;
  const summary = buildCompletionSummary(
    pending.surfaceType,
    actionId,
    mergedData,
    surfaceData,
  );

  // Use broadcastToAllClients so events reach the SSE hub — sendToClient is
  // reset to a no-op between HTTP requests (see history-restored path for
  // full rationale).
  const emit = ctx.broadcastToAllClients ?? ctx.sendToClient.bind(ctx);

  // Forms are one-shot surfaces — auto-complete immediately so the client
  // transitions from the "Submitting…" spinner to a completion chip without
  // requiring the LLM to call ui_dismiss.
  if (pending.surfaceType === "form") {
    emit({
      type: "ui_surface_complete",
      conversationId: ctx.conversationId,
      surfaceId,
      summary,
      submittedData: mergedData,
    });
  }

  let fallbackContent = `[User action on ${pending.surfaceType} surface: ${summary}]`;
  // Append structured data so the LLM has access to IDs/values it needs
  // to act on (e.g. selectedIds for archiving).
  if (mergedData && Object.keys(mergedData).length > 0) {
    fallbackContent += `\n\nAction data: ${JSON.stringify(mergedData)}`;
  }
  // Append deselection context for table/list surfaces so the LLM knows what the user chose to keep.
  const selectedIds = mergedData?.selectedIds as string[] | undefined;
  if (
    selectedIds &&
    (pending.surfaceType === "table" || pending.surfaceType === "list")
  ) {
    fallbackContent += buildDeselectionDescription(
      pending.surfaceType,
      stored,
      selectedIds,
    );
  }
  const accumulatedState = ctx.accumulatedSurfaceState.get(surfaceId);
  if (accumulatedState && Object.keys(accumulatedState).length > 0) {
    fallbackContent += `\n\nAccumulated surface state: ${JSON.stringify(accumulatedState)}`;
  }
  // When a relay_prompt button also carries selection data (e.g. list/table
  // surface with a canned prompt + user-selected rows), append the selection
  // context so the LLM sees both the prompt and the user's selections.
  let content = prompt || fallbackContent;
  if (prompt && selectedIds && mergedData) {
    if (pending.surfaceType === "table" || pending.surfaceType === "list") {
      content += buildDeselectionDescription(
        pending.surfaceType,
        stored,
        selectedIds,
      );
    }
  }
  // When prompt is truthy, fallbackContent (which includes accumulated state)
  // is discarded. Re-append accumulated state so the LLM sees it.
  if (prompt && accumulatedState && Object.keys(accumulatedState).length > 0) {
    content += `\n\nAccumulated surface state: ${JSON.stringify(accumulatedState)}`;
  }
  // Show the user plain-text instead of raw JSON action data.
  const displayContent = prompt
    ? undefined
    : buildUserFacingLabel(
        pending.surfaceType,
        actionId,
        mergedData,
        surfaceData,
      );

  const requestId = uuid();
  ctx.surfaceActionRequestIds.add(requestId);
  const onEvent = (msg: ServerMessage) => emit(msg);

  ctx.traceEmitter.emit("request_received", "Surface action received", {
    requestId,
    status: "info",
    attributes: { source: "surface_action", surfaceId, actionId },
  });

  const result = ctx.enqueueMessage(
    content,
    [],
    onEvent,
    requestId,
    surfaceId,
    undefined,
    undefined,
    undefined,
    displayContent,
  );
  if (result.rejected) {
    ctx.surfaceActionRequestIds.delete(requestId);
    return;
  }

  // One-shot: clear accumulated state now that the message has been accepted.
  // Deferred until after rejection check so state is preserved for retry on rejection.
  if (accumulatedState && Object.keys(accumulatedState).length > 0) {
    ctx.accumulatedSurfaceState.delete(surfaceId);
  }

  // Echo the user's prompt to the client so it appears in the chat UI.
  // Deferred until after rejection check to avoid ghost messages.
  if (shouldRelayPrompt && prompt) {
    emit({
      type: "user_message_echo",
      text: prompt,
      conversationId: ctx.conversationId,
    });
  }
  if (result.queued) {
    const position = ctx.getQueueDepth();
    if (!retainPending) {
      ctx.pendingSurfaceActions.delete(surfaceId);
    }
    log.info(
      { surfaceId, actionId, requestId },
      "Surface action queued (conversation busy)",
    );
    ctx.traceEmitter.emit(
      "request_queued",
      `Surface action queued at position ${position}`,
      {
        requestId,
        status: "info",
        attributes: { position },
      },
    );
    onEvent({
      type: "message_queued",
      conversationId: ctx.conversationId,
      requestId,
      position,
    });
    return;
  }

  if (!retainPending) {
    ctx.pendingSurfaceActions.delete(surfaceId);
  }
  log.info(
    { surfaceId, actionId, requestId },
    "Processing surface action as follow-up",
  );
  ctx
    .processMessage(
      content,
      [],
      onEvent,
      requestId,
      surfaceId,
      undefined,
      undefined,
      displayContent,
    )
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err, surfaceId, actionId },
        "Error processing surface action",
      );
      onEvent({
        type: "error",
        message: `Failed to process surface action: ${message}`,
      });
    });
}

/**
 * After an app_refresh, refresh any active surface that displays the updated app.
 */
export function refreshSurfacesForApp(
  ctx: SurfaceConversationContext,
  appId: string,
  opts?: { fileChange?: boolean; status?: string },
): boolean {
  const app = getApp(appId);
  if (!app) return false;

  let refreshed = false;
  for (const [surfaceId, stored] of ctx.surfaceState.entries()) {
    if (stored.surfaceType !== "dynamic_page") continue;
    const data = stored.data as DynamicPageSurfaceData;
    if (data.appId !== appId) continue;

    // Push current HTML onto the undo stack before overwriting
    pushUndoState(ctx.surfaceUndoStacks, surfaceId, data.html);

    // Update in-memory surface state so the next refinement gets fresh HTML
    const updatedData: DynamicPageSurfaceData = {
      ...data,
      html: app.htmlDefinition,
      ...(opts?.fileChange
        ? { reloadGeneration: (data.reloadGeneration ?? 0) + 1 }
        : {}),
      ...(opts?.status !== undefined ? { status: opts.status } : {}),
    };
    stored.data = updatedData;

    // Keep the persisted snapshot in sync so updates survive conversation restart.
    const idx = ctx.currentTurnSurfaces.findIndex(
      (s) => s.surfaceId === surfaceId,
    );
    if (idx !== -1) {
      ctx.currentTurnSurfaces[idx].data = updatedData;
    }

    // Push the update to the client
    ctx.sendToClient({
      type: "ui_surface_update",
      conversationId: ctx.conversationId,
      surfaceId,
      data: updatedData,
    });

    refreshed = true;
    log.info(
      { conversationId: ctx.conversationId, surfaceId, appId },
      "Auto-refreshed surface after app_refresh",
    );
  }
  return refreshed;
}

export function buildCompletionSummary(
  surfaceType: string | undefined,
  actionId: string,
  data?: Record<string, unknown>,
  surfaceData?: Record<string, unknown>,
): string {
  if (surfaceType === "confirmation") {
    if (actionId === "cancel") {
      const cancelLabel =
        typeof surfaceData?.cancelLabel === "string"
          ? surfaceData.cancelLabel
          : undefined;
      return cancelLabel ? `User chose: "${cancelLabel}"` : "Cancelled";
    }
    if (actionId === "confirm") return "Confirmed";
    // Preserve the actual action ID so the LLM knows the user's exact choice
    // (e.g. "deny", "no", "reject") rather than misreporting it as confirmed.
    return `User selected: ${actionId}`;
  }
  if (surfaceType === "form") {
    return "Submitted";
  }
  if (surfaceType === "list" && data) {
    const selectedIds = data.selectedIds as string[] | undefined;
    const actionSuffix = actionId ? ` (action: ${actionId})` : "";
    if (selectedIds?.length === 1)
      return `Selected: ${selectedIds[0]}${actionSuffix}`;
    if (selectedIds?.length)
      return `Selected ${selectedIds.length} items${actionSuffix}`;
  }
  if (surfaceType === "table" && data) {
    const selectedIds = data.selectedIds as string[] | undefined;
    const actionSuffix = actionId ? ` (action: ${actionId})` : "";
    if (selectedIds?.length === 1) return `Selected 1 row${actionSuffix}`;
    if (selectedIds?.length)
      return `Selected ${selectedIds.length} rows${actionSuffix}`;
  }
  return actionId.charAt(0).toUpperCase() + actionId.slice(1);
}

/**
 * Build a plain-text label shown to the user in the chat bubble for a
 * surface action. Unlike `buildCompletionSummary` (which is for the LLM),
 * this produces natural language the user can glance at.
 */
export function buildUserFacingLabel(
  surfaceType: string | undefined,
  actionId: string,
  data?: Record<string, unknown>,
  surfaceData?: Record<string, unknown>,
): string {
  const count = (data?.selectedIds as string[] | undefined)?.length;

  if (surfaceType === "confirmation") {
    if (actionId === "cancel") {
      const cancelLabel =
        typeof surfaceData?.cancelLabel === "string"
          ? surfaceData.cancelLabel
          : undefined;
      return cancelLabel ?? "Cancelled";
    }
    if (actionId === "confirm") return "Confirmed";
    return `Selected: ${actionId}`;
  }
  if (surfaceType === "form") return "Submitted";

  // Table / list selection actions
  if (count) {
    const noun = count === 1 ? "item" : "items";
    const action = actionId
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return `${action} ${count} ${noun}`;
  }

  // Generic fallback — humanize the action ID
  return actionId.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolve a proxy tool call that targets a UI surface.
 * Handles ui_show, ui_update, ui_dismiss, computer_use_* proxy tools, and app_open.
 */
export async function surfaceProxyResolver(
  ctx: SurfaceConversationContext,
  toolName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  // Route CU proxy tools (all computer_use_* action tools)
  if (toolName.startsWith("computer_use_")) {
    if (!ctx.hostCuProxy || !ctx.hostCuProxy.isAvailable()) {
      return {
        content: "Computer use is not available — no desktop client connected.",
        isError: true,
      };
    }

    // Terminal tools resolve immediately without a client round-trip
    if (
      toolName === "computer_use_done" ||
      toolName === "computer_use_respond"
    ) {
      const summary =
        typeof input.summary === "string"
          ? input.summary
          : typeof input.answer === "string"
            ? input.answer
            : "Task complete";
      ctx.hostCuProxy.reset();
      return { content: summary, isError: false };
    }

    // Record the action and proxy to the connected desktop client
    const reasoning =
      typeof input.reasoning === "string" ? input.reasoning : undefined;
    ctx.hostCuProxy.recordAction(toolName, input, reasoning);
    return ctx.hostCuProxy.request(
      toolName,
      input,
      ctx.conversationId,
      ctx.hostCuProxy.stepCount,
      reasoning,
      signal,
    );
  }

  if (toolName === "ui_show" || toolName === "ui_update") {
    const caps = ctx.channelCapabilities;
    if (caps && !caps.supportsDynamicUi) {
      log.info(
        { toolName, channel: caps.channel, conversationId: ctx.conversationId },
        "Blocked UI surface tool on channel without dynamic UI support",
      );
      return {
        content: `${toolName} is unavailable on channel "${caps.channel}" because this channel cannot render dynamic UI surfaces. Use text responses or a messaging/notification tool instead.`,
        isError: true,
      };
    }
  }

  if (toolName === "ui_show") {
    const surfaceId = uuid();
    const surfaceType = input.surface_type as SurfaceType;
    const title = typeof input.title === "string" ? input.title : undefined;
    const rawData = isPlainObject(input.data) ? input.data : {};
    const data = (
      surfaceType === "card"
        ? normalizeCardShowData(input, rawData)
        : surfaceType === "dynamic_page"
          ? normalizeDynamicPageShowData(input, rawData)
          : rawData
    ) as SurfaceData;
    const actions = input.actions as
      | Array<{
          id: string;
          label: string;
          style?: string;
          data?: Record<string, unknown>;
        }>
      | undefined;
    // Interactive surfaces default to awaiting user action.
    const hasActions = Array.isArray(actions) && actions.length > 0;
    const isInteractive =
      surfaceType === "card"
        ? hasActions
        : surfaceType === "list"
          ? hasActions
          : surfaceType === "table"
            ? hasActions
            : INTERACTIVE_SURFACE_TYPES.includes(surfaceType);
    const awaitAction = (input.await_action as boolean) ?? isInteractive;

    // Only one non-persistent interactive surface at a time. If another
    // surface is already awaiting user input, reject this one so the LLM
    // presents surfaces sequentially.
    if (awaitAction) {
      const hasExistingPending = [...ctx.pendingSurfaceActions.values()].some(
        (entry) => entry.surfaceType !== "dynamic_page",
      );
      if (hasExistingPending) {
        return {
          content:
            "Another interactive surface is already awaiting user input. Present one at a time — wait for the user to respond to the current surface before showing the next.",
          isError: true,
        };
      }
    }

    const display = (input.display as string) === "panel" ? "panel" : "inline";

    const mappedActions = actions?.map((a) => ({
      id: a.id,
      label: a.label,
      style: (a.style ?? "secondary") as
        | "primary"
        | "secondary"
        | "destructive",
      ...(a.data ? { data: a.data } : {}),
    }));

    // Track surface state for ui_update merging (includes actions so we can
    // look up per-action data payloads when the client sends an action back).
    ctx.surfaceState.set(surfaceId, {
      surfaceType,
      data,
      title,
      actions: mappedActions,
    });

    log.info(
      {
        surfaceId,
        surfaceType,
        title,
        dataKeys: Object.keys(data),
        actionCount: mappedActions?.length ?? 0,
        display,
        conversationId: ctx.conversationId,
      },
      "Sending ui_surface_show to client",
    );

    ctx.sendToClient({
      type: "ui_surface_show",
      conversationId: ctx.conversationId,
      surfaceId,
      surfaceType,
      title,
      data,
      actions: mappedActions,
      display,
    } as unknown as UiSurfaceShow);

    // Track surface for persistence with the message
    ctx.currentTurnSurfaces.push({
      surfaceId,
      surfaceType,
      title,
      data,
      actions: mappedActions,
      display,
    });

    if (awaitAction) {
      ctx.pendingSurfaceActions.set(surfaceId, { surfaceType });
      return {
        content: JSON.stringify({
          surfaceId,
          status: "awaiting_user_action",
          message:
            "Surface displayed and the user can see it. Their response will arrive as a follow-up message. Do not output any waiting message — just stop here.",
        }),
        isError: false,
        yieldToUser: true,
      };
    }
    return { content: JSON.stringify({ surfaceId }), isError: false };
  }

  if (toolName === "ui_update") {
    const surfaceId = input.surface_id as string;
    let patch = (isPlainObject(input.data) ? input.data : {}) as Record<
      string,
      unknown
    >;

    // Merge the partial patch into the stored full surface data
    const stored = ctx.surfaceState.get(surfaceId);
    let mergedData: SurfaceData;
    if (stored) {
      if (stored.surfaceType === "card") {
        patch = normalizeTaskProgressCardPatch(
          stored.data as CardSurfaceData,
          patch,
        );
      }
      // Push current HTML to undo stack for dynamic pages
      if (stored.surfaceType === "dynamic_page") {
        const currentHtml = (stored.data as DynamicPageSurfaceData).html;
        pushUndoState(ctx.surfaceUndoStacks, surfaceId, currentHtml);
      }
      mergedData = { ...stored.data, ...patch } as SurfaceData;
      stored.data = mergedData;
    } else {
      mergedData = patch as unknown as SurfaceData;
    }

    ctx.sendToClient({
      type: "ui_surface_update",
      conversationId: ctx.conversationId,
      surfaceId,
      data: mergedData,
    });

    // Keep the persisted snapshot in sync so updates survive conversation restart.
    const idx = ctx.currentTurnSurfaces.findIndex(
      (s) => s.surfaceId === surfaceId,
    );
    if (idx !== -1) {
      ctx.currentTurnSurfaces[idx].data = mergedData;
    }

    return { content: "Surface updated", isError: false };
  }

  if (toolName === "ui_dismiss") {
    const surfaceId = input.surface_id as string;
    const lastAction = ctx.lastSurfaceAction.get(surfaceId);
    const stored = ctx.surfaceState.get(surfaceId);
    if (lastAction) {
      const summary = buildCompletionSummary(
        stored?.surfaceType,
        lastAction.actionId,
        lastAction.data,
        stored?.data as Record<string, unknown> | undefined,
      );
      ctx.sendToClient({
        type: "ui_surface_complete",
        conversationId: ctx.conversationId,
        surfaceId,
        summary,
        submittedData: lastAction.data,
      });
    } else {
      ctx.sendToClient({
        type: "ui_surface_dismiss",
        conversationId: ctx.conversationId,
        surfaceId,
      });
    }
    ctx.pendingSurfaceActions.delete(surfaceId);
    ctx.surfaceState.delete(surfaceId);
    ctx.surfaceUndoStacks.delete(surfaceId);
    ctx.lastSurfaceAction.delete(surfaceId);
    ctx.accumulatedSurfaceState.delete(surfaceId);
    return {
      content: lastAction ? "Surface completed" : "Surface dismissed",
      isError: false,
    };
  }

  if (toolName === "app_open") {
    const appId = input.app_id as string;
    const preview = input.preview as DynamicPageSurfaceData["preview"];
    const openMode = input.open_mode as string | undefined;
    const app = getApp(appId);
    if (!app) return { content: `App not found: ${appId}`, isError: true };
    // Generate a minimal fallback preview from app metadata so that the
    // surface is always rendered as a clickable preview card (not an
    // un-clickable fallback chip) after conversation restart.
    const defaultPreview = { title: app.name, subtitle: app.description };

    const storedPreview = getAppPreview(app.id);
    const { dirName } = resolveAppDir(app.id);
    const surfaceData: DynamicPageSurfaceData = {
      html: app.htmlDefinition,
      appId: app.id,
      dirName,
      preview: {
        ...defaultPreview,
        ...preview,
        ...(storedPreview ? { previewImage: storedPreview } : {}),
      },
    };
    const surfaceId = uuid();

    if (openMode === "preview") {
      // Inline-only preview card emitted during app_create — do not open a
      // workspace panel and do not register surface state. The client renders
      // this as a tappable inline card that opens the app on demand.
      ctx.sendToClient({
        type: "ui_surface_show",
        conversationId: ctx.conversationId,
        surfaceId,
        surfaceType: "dynamic_page",
        title: app.name,
        data: surfaceData,
        display: "inline",
      } as UiSurfaceShow);

      // Track for message persistence so the inline card survives history reload.
      ctx.currentTurnSurfaces.push({
        surfaceId,
        surfaceType: "dynamic_page",
        title: app.name,
        data: surfaceData,
        display: "inline",
      });

      return { content: JSON.stringify({ surfaceId, appId }), isError: false };
    }

    ctx.surfaceState.set(surfaceId, {
      surfaceType: "dynamic_page",
      data: surfaceData,
      title: app.name,
    });

    ctx.sendToClient({
      type: "ui_surface_show",
      conversationId: ctx.conversationId,
      surfaceId,
      surfaceType: "dynamic_page",
      title: app.name,
      data: surfaceData,
    } as UiSurfaceShow);

    // Track surface for persistence
    ctx.currentTurnSurfaces.push({
      surfaceId,
      surfaceType: "dynamic_page",
      title: app.name,
      data: surfaceData,
    });

    ctx.pendingSurfaceActions.set(surfaceId, { surfaceType: "dynamic_page" });

    return { content: JSON.stringify({ surfaceId, appId }), isError: false };
  }

  return { content: `Unknown proxy tool: ${toolName}`, isError: true };
}
