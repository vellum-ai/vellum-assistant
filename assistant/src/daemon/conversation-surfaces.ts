import { v4 as uuid } from "uuid";

import {
  addAppConversationId,
  getApp,
  getAppDirPath,
  getAppPreview,
  isMultifileApp,
  resolveAppDir,
  resolveEffectiveAppHtml,
  updateApp,
} from "../memory/app-store.js";
import {
  getMessages,
  updateMessageContent,
} from "../memory/conversation-crud.js";
import { broadcastMessage } from "../runtime/assistant-event-hub.js";
import type {
  InteractiveUiRequest,
  InteractiveUiResult,
} from "../runtime/interactive-ui-types.js";
import type { ToolExecutionResult } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import { isPlainObject } from "../util/object.js";
import { buildConversationErrorMessage } from "./conversation-error.js";
import { launchConversation } from "./conversation-launch.js";
import type { HostCuProxy } from "./host-cu-proxy.js";
import type {
  CardSurfaceData,
  ConfirmationSurfaceData,
  DynamicPageSurfaceData,
  FormSurfaceData,
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
import type { ConversationTransportMetadata } from "./message-types/conversations.js";
import type { UserMessageAttachment } from "./message-types/shared.js";
import type { TrustContext } from "./trust-context.js";

const log = getLogger("conversation-surfaces");

const MAX_UNDO_DEPTH = 10;

/**
 * Mark a `ui_surface` content block as completed in the database so that
 * history reconstruction preserves the completion state.  Also updates
 * in-memory messages when available.
 */
export function markSurfaceCompleted(
  ctx: { conversationId: string; messages?: Array<{ content: unknown }> },
  surfaceId: string,
  summary: string,
): void {
  // Update in-memory messages when available so subsequent reads within
  // this session see the change without waiting for DB.
  if (ctx.messages) {
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const msg = ctx.messages[i];
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        const b = block as Record<string, unknown>;
        if (b.type === "ui_surface" && b.surfaceId === surfaceId) {
          b.completed = true;
          b.completionSummary = summary;
          break;
        }
      }
    }
  }

  // Persist to DB.
  try {
    const rows = getMessages(ctx.conversationId);
    for (let r = rows.length - 1; r >= 0; r--) {
      let parsed: unknown[];
      try {
        const result = JSON.parse(rows[r].content);
        if (!Array.isArray(result)) continue;
        parsed = result;
      } catch {
        // Some rows store plain text content (e.g. notification seeding) —
        // skip them and keep scanning.
        continue;
      }
      let found = false;
      for (const pb of parsed) {
        const rb = pb as Record<string, unknown>;
        if (rb.type === "ui_surface" && rb.surfaceId === surfaceId) {
          rb.completed = true;
          rb.completionSummary = summary;
          found = true;
          break;
        }
      }
      if (found) {
        updateMessageContent(rows[r].id, JSON.stringify(parsed));
        return;
      }
    }
  } catch (err) {
    log.warn({ err, surfaceId }, "Failed to persist surface completion to DB");
  }
}
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
  /** Assistant id (if known) — used when publishing launch-triggered events. */
  readonly assistantId?: string;
  /** Inherited to spawned conversations in the `launch_conversation` action path. */
  readonly trustContext?: TrustContext;
  readonly channelCapabilities?: {
    channel: string;
    supportsDynamicUi: boolean;
  };
  readonly traceEmitter: {
    emit(type: string, message: string, meta?: Record<string, unknown>): void;
  };
  sendToClient(msg: ServerMessage): void;
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
  /**
   * Pending standalone UI requests keyed by surfaceId.
   * These are daemon-driven surfaces (not LLM tool invocations) that block
   * the caller until the user submits, cancels, or the timeout elapses.
   * Optional: only present on conversations that support standalone surfaces.
   */
  pendingStandaloneSurfaces?: Map<
    string,
    {
      resolve: (result: InteractiveUiResult) => void;
      timer: ReturnType<typeof setTimeout>;
      surfaceType: SurfaceType;
    }
  >;
  /**
   * Short-lived tombstone set of recently-completed standalone surface IDs.
   * Prevents late client actions (arriving after timeout/resolution) from
   * falling through to the history-restored path and triggering an
   * unintended LLM turn. Entries are auto-removed after a TTL.
   */
  recentlyCompletedStandaloneSurfaces?: Map<
    string,
    ReturnType<typeof setTimeout>
  >;
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
    persistent?: boolean;
  }>;
  /** Optional proxy for delegating computer-use actions to a connected desktop client. */
  hostCuProxy?: HostCuProxy;
  /** True when no interactive client is connected (headless / channel-only). */
  readonly hasNoClient?: boolean;
  isProcessing(): boolean;
  enqueueMessage(
    content: string,
    attachments: UserMessageAttachment[],
    onEvent?: (msg: ServerMessage) => void,
    requestId?: string,
    activeSurfaceId?: string,
    currentPage?: string,
    metadata?: Record<string, unknown>,
    options?: { isInteractive?: boolean },
    displayContent?: string,
    transport?: ConversationTransportMetadata,
  ): { queued: boolean; requestId: string; rejected?: boolean };
  getQueueDepth(): number;
  processMessage(
    content: string,
    attachments: UserMessageAttachment[],
    onEvent?: (msg: ServerMessage) => void,
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

// ── Standalone surface lifecycle ────────────────────────────────────
//
// Daemon-driven UI surfaces that block the caller (skill, IPC handler)
// until the user responds or the timeout elapses. Unlike LLM-invoked
// surfaces (ui_show tool), these never trigger an LLM follow-up turn —
// the result is returned directly to the requesting code.

/** Default timeout for standalone surfaces when the caller does not specify one. */
const DEFAULT_STANDALONE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * How long a tombstone entry persists after a standalone surface is completed.
 * Late client actions arriving within this window are silently dropped.
 */
const STANDALONE_TOMBSTONE_TTL_MS = 30_000; // 30 seconds

/**
 * Check whether the conversation can show interactive UI surfaces.
 * Fails closed when no client is connected or the channel doesn't
 * support dynamic UI.
 */
export function canShowInteractiveUi(
  ctx: Pick<SurfaceConversationContext, "hasNoClient" | "channelCapabilities">,
): boolean {
  if (ctx.hasNoClient) return false;
  if (ctx.channelCapabilities && !ctx.channelCapabilities.supportsDynamicUi) {
    return false;
  }
  return true;
}

/**
 * Show a standalone UI surface and return a Promise that resolves when
 * the user submits, cancels, or the timeout elapses.
 *
 * This is the core entry point for daemon-driven (non-LLM) UI requests.
 * It performs the fail-closed capability check, emits `ui_surface_show`,
 * stores surface state, arms the timeout, and registers a pending entry
 * so that `handleSurfaceAction` can intercept the callback.
 */
export function showStandaloneSurface(
  ctx: SurfaceConversationContext,
  request: InteractiveUiRequest,
  surfaceId: string,
): Promise<InteractiveUiResult> {
  // ── Fail-closed: no interactive UI capability ──
  if (!canShowInteractiveUi(ctx)) {
    log.warn(
      {
        conversationId: ctx.conversationId,
        surfaceType: request.surfaceType,
        hasNoClient: ctx.hasNoClient,
        channel: ctx.channelCapabilities?.channel,
      },
      "standalone surface: no interactive UI capability; failing closed",
    );
    return Promise.resolve({
      status: "cancelled" as const,
      surfaceId,
      cancellationReason: "no_interactive_surface",
    });
  }

  // The pendingStandaloneSurfaces map must exist on the context.
  // The Conversation class always initializes it; if absent, fail closed.
  if (!ctx.pendingStandaloneSurfaces) {
    log.warn(
      { conversationId: ctx.conversationId, surfaceType: request.surfaceType },
      "standalone surface: pendingStandaloneSurfaces map missing; failing closed",
    );
    return Promise.resolve({
      status: "cancelled" as const,
      surfaceId,
      cancellationReason: "no_interactive_surface",
    });
  }
  const pendingMap = ctx.pendingStandaloneSurfaces;

  const timeoutMs = request.timeoutMs ?? DEFAULT_STANDALONE_TIMEOUT_MS;

  // Build surface data from the request payload.
  const surfaceType = request.surfaceType as SurfaceType;
  const data = buildStandaloneSurfaceData(request);
  const actions = request.actions?.map((a) => ({
    id: a.id,
    label: a.label,
    style: (a.variant === "danger"
      ? "destructive"
      : (a.variant ?? "secondary")) as "primary" | "secondary" | "destructive",
  }));

  return new Promise<InteractiveUiResult>((resolve) => {
    // ── Arm timeout ──
    const timer = setTimeout(() => {
      // Notify the client BEFORE cleanup so the surface is dismissed on
      // the client side, preventing stale user interactions from reaching
      // handleSurfaceAction and being misrouted to the LLM.
      try {
        broadcastMessage({
          type: "ui_surface_complete",
          conversationId: ctx.conversationId,
          surfaceId,
          summary: "Timed out",
        });
      } catch (err) {
        log.warn(
          { err, conversationId: ctx.conversationId, surfaceId },
          "Failed to emit ui_surface_complete on timeout",
        );
      }

      cleanupStandaloneSurface(ctx, surfaceId);
      log.info(
        { conversationId: ctx.conversationId, surfaceId, timeoutMs },
        "standalone surface timed out",
      );
      resolve({ status: "timed_out", surfaceId });
    }, timeoutMs);

    // ── Register pending entry ──
    pendingMap.set(surfaceId, {
      resolve,
      timer,
      surfaceType,
    });

    // ── Store surface state ──
    ctx.surfaceState.set(surfaceId, {
      surfaceType,
      data,
      title: request.title,
      actions,
    });

    broadcastMessage({
      type: "ui_surface_show",
      conversationId: ctx.conversationId,
      surfaceId,
      surfaceType,
      title: request.title,
      data,
      actions,
      display: "inline",
    } as unknown as UiSurfaceShow);

    log.info(
      {
        conversationId: ctx.conversationId,
        surfaceId,
        surfaceType,
        timeoutMs,
      },
      "standalone surface shown",
    );
  });
}

/**
 * Build a SurfaceData object from an InteractiveUiRequest.
 * Maps the generic `data` payload to the typed shape expected by the
 * surface type.
 */
function buildStandaloneSurfaceData(
  request: InteractiveUiRequest,
): SurfaceData {
  if (request.surfaceType === "confirmation") {
    return {
      message:
        typeof request.data.message === "string"
          ? request.data.message
          : (request.title ?? "Please confirm"),
      detail:
        typeof request.data.detail === "string"
          ? request.data.detail
          : undefined,
      confirmLabel:
        typeof request.data.confirmLabel === "string"
          ? request.data.confirmLabel
          : undefined,
      cancelLabel:
        typeof request.data.cancelLabel === "string"
          ? request.data.cancelLabel
          : undefined,
      destructive:
        typeof request.data.destructive === "boolean"
          ? request.data.destructive
          : undefined,
    } satisfies ConfirmationSurfaceData;
  }

  if (request.surfaceType === "form") {
    // Preserve the full form payload (pages, pageLabels, and any future
    // additive keys) via spreading. Apply defensive normalization so that
    // `fields` is always a valid array — callers that use `pages` instead
    // of top-level `fields` may omit the latter entirely.
    const raw = request.data as Record<string, unknown>;
    const hasFields = Array.isArray(raw.fields) && raw.fields.length > 0;
    const fields: FormSurfaceData["fields"] = hasFields
      ? (raw.fields as FormSurfaceData["fields"])
      : [];

    return {
      ...raw,
      fields,
    } as FormSurfaceData;
  }

  // Fallback: pass through opaque data
  return request.data as unknown as SurfaceData;
}

/**
 * Cleanup a standalone surface entry: clear the timeout timer, remove
 * the pending entry, remove surface state, and record a short-lived
 * tombstone so late client actions are silently dropped instead of
 * falling through to the LLM path. Idempotent — safe to call multiple
 * times for the same surfaceId.
 */
export function cleanupStandaloneSurface(
  ctx: Pick<
    SurfaceConversationContext,
    | "pendingStandaloneSurfaces"
    | "recentlyCompletedStandaloneSurfaces"
    | "surfaceState"
    | "pendingSurfaceActions"
    | "lastSurfaceAction"
    | "accumulatedSurfaceState"
    | "surfaceUndoStacks"
  >,
  surfaceId: string,
): void {
  const entry = ctx.pendingStandaloneSurfaces?.get(surfaceId);
  if (entry) {
    clearTimeout(entry.timer);
    ctx.pendingStandaloneSurfaces?.delete(surfaceId);
  }
  ctx.surfaceState.delete(surfaceId);
  ctx.pendingSurfaceActions.delete(surfaceId);
  ctx.lastSurfaceAction.delete(surfaceId);
  ctx.accumulatedSurfaceState.delete(surfaceId);
  ctx.surfaceUndoStacks.delete(surfaceId);

  // Record a tombstone so late client actions are silently dropped.
  if (ctx.recentlyCompletedStandaloneSurfaces) {
    // Clear any existing tombstone timer for this surfaceId (idempotency).
    const existingTimer =
      ctx.recentlyCompletedStandaloneSurfaces.get(surfaceId);
    if (existingTimer) clearTimeout(existingTimer);

    const tombstoneTimer = setTimeout(() => {
      ctx.recentlyCompletedStandaloneSurfaces?.delete(surfaceId);
    }, STANDALONE_TOMBSTONE_TTL_MS);
    ctx.recentlyCompletedStandaloneSurfaces.set(surfaceId, tombstoneTimer);
  }
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

function pushUndoState(
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

export type SurfaceActionResult =
  | { accepted: true; conversationId: string }
  | { accepted: false; error: string }
  | void;

export async function handleSurfaceAction(
  ctx: SurfaceConversationContext,
  surfaceId: string,
  actionId: string,
  data?: Record<string, unknown>,
): Promise<SurfaceActionResult> {
  // ── Standalone surface interception ──────────────────────────────
  // Daemon-driven surfaces (from `requestInteractiveUi`) register a
  // pending entry in `pendingStandaloneSurfaces`. When the user clicks
  // an action, resolve the caller's Promise directly and return WITHOUT
  // enqueuing a model message — consumed standalone callbacks never
  // trigger an LLM follow-up turn.
  //
  // This block runs BEFORE launch_conversation dispatch so that a
  // standalone form whose submittedData happens to contain
  // `_action: "launch_conversation"` is resolved as a standalone
  // interaction rather than triggering a conversation launch.
  const standalone = ctx.pendingStandaloneSurfaces?.get(surfaceId);
  if (standalone) {
    const stored = ctx.surfaceState.get(surfaceId);
    const summary = buildCompletionSummary(
      standalone.surfaceType,
      actionId,
      data,
      stored?.data as Record<string, unknown> | undefined,
    );

    // Determine result status from the action.
    const isCancellation = actionId === "cancel" || actionId === "dismiss";
    const status: InteractiveUiResult["status"] = isCancellation
      ? "cancelled"
      : "submitted";

    const result: InteractiveUiResult = {
      status,
      surfaceId,
      actionId,
      ...(data ? { submittedData: data } : {}),
      ...(isCancellation
        ? { cancellationReason: "user_dismissed" as const }
        : {}),
      summary,
    };

    broadcastMessage({
      type: "ui_surface_complete",
      conversationId: ctx.conversationId,
      surfaceId,
      summary,
      submittedData: data,
    });

    // Cleanup and resolve — order matters: cleanup clears the timer
    // before resolve() unblocks the caller.
    cleanupStandaloneSurface(ctx, surfaceId);
    standalone.resolve(result);

    log.info(
      {
        conversationId: ctx.conversationId,
        surfaceId,
        actionId,
        status,
      },
      "standalone surface resolved by user action",
    );

    // Return without enqueuing a model message.
    return { accepted: true, conversationId: ctx.conversationId };
  }

  // ── Tombstone guard for recently-completed standalone surfaces ────
  // After a standalone surface times out or is resolved, cleanup removes
  // all state. Without this guard a late client action would fall through
  // to the history-restored path below and enqueue a message to the LLM.
  if (ctx.recentlyCompletedStandaloneSurfaces?.has(surfaceId)) {
    log.debug(
      { conversationId: ctx.conversationId, surfaceId, actionId },
      "Dropping late action for recently-completed standalone surface",
    );
    return { accepted: true, conversationId: ctx.conversationId };
  }

  // `launch_conversation` actions spawn a fresh conversation inline instead
  // of round-tripping through the LLM with a `[User action on card surface:
  // ...]` chat message. This dispatch must run BEFORE the pending-vs-not
  // branching below: `ui_show` unconditionally calls
  // `pendingSurfaceActions.set(...)` for any interactive card (regardless of
  // the `persistent` flag), so on the very first click of a freshly-rendered
  // launcher card `pending` is already set. Without this hoist the launch
  // branch would fall through into the pending path and the LLM round-trip
  // would happen on every click.
  if (
    data &&
    typeof data === "object" &&
    (data as Record<string, unknown>)._action === "launch_conversation"
  ) {
    const payload = data as Record<string, unknown>;
    const title = typeof payload.title === "string" ? payload.title : "";
    const seedPrompt =
      typeof payload.seedPrompt === "string" ? payload.seedPrompt : "";
    const anchorMessageId =
      typeof payload.anchorMessageId === "string"
        ? payload.anchorMessageId
        : undefined;
    if (!title || !seedPrompt) {
      return { accepted: false, error: "missing_title_or_seedPrompt" };
    }
    // Launch actions don't consume the surface — persistent launcher cards
    // keep accepting clicks afterward. Drop the pending entry (if any) so
    // sibling button presses on the same card aren't blocked behind a stale
    // expectation that this surface still owes an answer to the LLM.
    ctx.pendingSurfaceActions.delete(surfaceId);
    // `ctx` is the origin Conversation — inherit its trust context so the
    // spawned conversation keeps guardian / trust-class state.
    //
    // `launchConversation` is the sole emitter of `open_conversation` for
    // this path. We pass `focus: false` so the client registers a sidebar
    // entry for the spawned conversation without switching focus away from
    // the origin — critical for fan-out UX where one click launches
    // multiple conversations.
    //
    // The helper also kicks off the seed turn fire-and-forget, so this
    // `await` resolves as soon as the conversation is created + titled +
    // published to the event hub. The HTTP POST /v1/surface-actions
    // response returns promptly — the seed turn runs in the background.
    const originTrustContext = ctx.trustContext;
    const { conversationId } = await launchConversation({
      title,
      seedPrompt,
      focus: false,
      ...(anchorMessageId ? { anchorMessageId } : {}),
      ...(originTrustContext ? { originTrustContext } : {}),
    });
    log.info(
      { originConversationId: ctx.conversationId, conversationId, surfaceId },
      "launch_conversation dispatched inline from surface action",
    );
    return { accepted: true, conversationId };
  }

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

    // Extract file attachments from action data so they are sent as proper
    // image/file content blocks instead of dumping base64 into the text.
    let attachments: UserMessageAttachment[] = [];
    let actionDataForText = data;
    if (data && Array.isArray(data.files)) {
      const files = data.files as Array<Record<string, unknown>>;
      attachments = files
        .filter(
          (f) =>
            typeof f.filename === "string" &&
            typeof f.mimeType === "string" &&
            typeof f.data === "string",
        )
        .map((f) => ({
          filename: f.filename as string,
          mimeType: f.mimeType as string,
          data: f.data as string,
          ...(typeof f.extractedText === "string"
            ? { extractedText: f.extractedText }
            : {}),
        }));
      // Only remove files from the text payload when we successfully parsed
      // attachments — otherwise preserve the original data so the model still
      // sees the files field (e.g. IDs/paths from dynamic app actions).
      if (attachments.length > 0) {
        const { files: _files, ...rest } = data;
        actionDataForText = Object.keys(rest).length > 0 ? rest : undefined;
      }
    }

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
      if (attachments.length > 0) {
        const names = attachments.map((a) => a.filename).join(", ");
        content += `\n\nUploaded files: ${names}`;
      }
      if (actionDataForText && Object.keys(actionDataForText).length > 0) {
        content += `\n\nAction data: ${JSON.stringify(actionDataForText)}`;
      }
      if (hasAccState) {
        content += `\n\nAccumulated surface state: ${JSON.stringify(accState)}`;
      }
      displayContent = summary;
    }

    log.info(
      {
        surfaceId,
        actionId,
        contentLength: content.length,
        contentPreview: content.slice(0, 200),
        attachmentCount: attachments.length,
        attachments: attachments.map((a) => ({
          filename: a.filename,
          mimeType: a.mimeType,
          dataLength: a.data?.length ?? 0,
          hasExtractedText: !!a.extractedText,
        })),
      },
      "Surface action: preparing to send message to model",
    );

    const requestId = uuid();
    ctx.surfaceActionRequestIds.add(requestId);
    // Pass conversationId so events without an inline conversationId (e.g.
    // text_delta) are published with the correct conversation scope and
    // reach the SSE subscriber filtered to this conversation.
    const onEvent = (msg: ServerMessage) =>
      broadcastMessage(msg, ctx.conversationId);

    ctx.traceEmitter.emit("request_received", "Surface action received", {
      requestId,
      status: "info",
      attributes: { source: "surface_action", surfaceId, actionId },
    });

    const result = ctx.enqueueMessage(
      content,
      attachments,
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
      broadcastMessage({
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
      { surfaceId, actionId, requestId, attachmentCount: attachments.length },
      "Processing surface action immediately (history-restored) with attachments",
    );
    ctx
      .processMessage(
        content,
        attachments,
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

  // Forms are one-shot surfaces — auto-complete immediately so the client
  // transitions from the "Submitting…" spinner to a completion chip without
  // requiring the LLM to call ui_dismiss.
  if (pending.surfaceType === "form") {
    broadcastMessage({
      type: "ui_surface_complete",
      conversationId: ctx.conversationId,
      surfaceId,
      summary,
      submittedData: mergedData,
    });
    markSurfaceCompleted(ctx, surfaceId, summary);
  }

  // Extract file attachments from action data so they are sent as proper
  // image/file content blocks instead of dumping base64 into the text.
  let pendingAttachments: UserMessageAttachment[] = [];
  let mergedDataForText = mergedData;
  if (mergedData && Array.isArray(mergedData.files)) {
    const files = mergedData.files as Array<Record<string, unknown>>;
    pendingAttachments = files
      .filter(
        (f) =>
          typeof f.filename === "string" &&
          typeof f.mimeType === "string" &&
          typeof f.data === "string",
      )
      .map((f) => ({
        filename: f.filename as string,
        mimeType: f.mimeType as string,
        data: f.data as string,
        ...(typeof f.extractedText === "string"
          ? { extractedText: f.extractedText }
          : {}),
      }));
    // Only remove files from the text payload when we successfully parsed
    // attachments — otherwise preserve the original data so the model still
    // sees the files field.
    if (pendingAttachments.length > 0) {
      const { files: _files, ...rest } = mergedData;
      mergedDataForText = Object.keys(rest).length > 0 ? rest : undefined;
    }
  }

  let fallbackContent = `[User action on ${pending.surfaceType} surface: ${summary}]`;
  if (pendingAttachments.length > 0) {
    const names = pendingAttachments.map((a) => a.filename).join(", ");
    fallbackContent += `\n\nUploaded files: ${names}`;
  }
  // Append structured data so the LLM has access to IDs/values it needs
  // to act on (e.g. selectedIds for archiving).
  if (mergedDataForText && Object.keys(mergedDataForText).length > 0) {
    fallbackContent += `\n\nAction data: ${JSON.stringify(mergedDataForText)}`;
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
  // Pass conversationId so events without an inline conversationId (e.g.
  // text_delta) are published with the correct conversation scope and
  // reach the SSE subscriber filtered to this conversation.
  const onEvent = (msg: ServerMessage) =>
    broadcastMessage(msg, ctx.conversationId);

  ctx.traceEmitter.emit("request_received", "Surface action received", {
    requestId,
    status: "info",
    attributes: { source: "surface_action", surfaceId, actionId },
  });

  log.info(
    {
      surfaceId,
      actionId,
      attachmentCount: pendingAttachments.length,
      attachments: pendingAttachments.map((a) => ({
        filename: a.filename,
        mimeType: a.mimeType,
        dataLength: a.data?.length ?? 0,
      })),
      contentPreview: content.slice(0, 200),
    },
    "Surface action follow-up: preparing to send message to model",
  );

  const result = ctx.enqueueMessage(
    content,
    pendingAttachments,
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
    broadcastMessage({
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
    {
      surfaceId,
      actionId,
      requestId,
      attachmentCount: pendingAttachments.length,
    },
    "Processing surface action as follow-up with attachments",
  );
  ctx
    .processMessage(
      content,
      pendingAttachments,
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
        conversationId: ctx.conversationId,
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

    // Update in-memory surface state so the next refinement gets fresh HTML.
    // For multifile apps, resolve the compiled dist/index.html with inlined
    // assets rather than the empty root index.html (app.htmlDefinition).
    const updatedData: DynamicPageSurfaceData = {
      ...data,
      html: resolveEffectiveAppHtml(app),
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
    if (actionId === "confirm") {
      const confirmLabel =
        typeof surfaceData?.confirmLabel === "string"
          ? surfaceData.confirmLabel
          : undefined;
      return confirmLabel ? `User chose: "${confirmLabel}"` : "Confirmed";
    }
    if (actionId === "deny") {
      // The deny button's custom label is passed as cancelLabel in the
      // confirmation surface data (the deny action reuses the cancel label
      // since both represent the "reject" path).
      const denyLabel =
        typeof surfaceData?.cancelLabel === "string"
          ? surfaceData.cancelLabel
          : undefined;
      return denyLabel ? `User chose: "${denyLabel}"` : "Denied";
    }
    // Preserve the actual action ID so the LLM knows the user's exact choice
    // rather than misreporting it as confirmed.
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
function buildUserFacingLabel(
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
    if (actionId === "confirm") {
      const confirmLabel =
        typeof surfaceData?.confirmLabel === "string"
          ? surfaceData.confirmLabel
          : undefined;
      return confirmLabel ?? "Confirmed";
    }
    if (actionId === "deny") {
      const denyLabel =
        typeof surfaceData?.cancelLabel === "string"
          ? surfaceData.cancelLabel
          : undefined;
      return denyLabel ?? "Denied";
    }
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
    // `persistent: true` keeps the card visible through action clicks (only
    // marks the clicked action as spent). Forward the flag so
    // `SurfaceManager.showSurface` on the client sees it — without this the
    // field is dropped and every card dismisses on first click.
    const persistent = input.persistent === true ? true : undefined;

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
        persistent: persistent ?? false,
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
      ...(persistent ? { persistent: true } : {}),
    } as unknown as UiSurfaceShow);

    // Track surface for persistence with the message
    ctx.currentTurnSurfaces.push({
      surfaceId,
      surfaceType,
      title,
      data,
      actions: mappedActions,
      display,
      ...(persistent ? { persistent: true } : {}),
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
      markSurfaceCompleted(ctx, surfaceId, summary);
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

    // Track conversation association (best-effort — failures must not break open flow).
    try {
      addAppConversationId(appId, ctx.conversationId);
    } catch (err) {
      log.warn({ err, appId }, "Failed to track conversation ID on app_open");
    }

    // Generate a minimal fallback preview from app metadata so that the
    // surface is always rendered as a clickable preview card (not an
    // un-clickable fallback chip) after conversation restart.
    const defaultPreview = { title: app.name, subtitle: app.description };

    const storedPreview = getAppPreview(app.id);
    const { dirName } = resolveAppDir(app.id);

    // For multifile TSX apps, auto-compile if dist is missing, then
    // resolve HTML from compiled dist/index.html with inlined assets.
    if (isMultifileApp(app)) {
      const { existsSync } = await import("node:fs");
      const { join } = await import("node:path");
      const appDir = getAppDirPath(app.id);
      const distIndex = join(appDir, "dist", "index.html");
      if (!existsSync(distIndex)) {
        const { compileApp } = await import("../bundler/app-compiler.js");
        const result = await compileApp(appDir);
        if (!result.ok) {
          log.warn(
            { appId, errors: result.errors },
            "Auto-compile failed on app_open",
          );
        }
      }
    }
    const html = resolveEffectiveAppHtml(app);

    const surfaceData: DynamicPageSurfaceData = {
      html,
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
