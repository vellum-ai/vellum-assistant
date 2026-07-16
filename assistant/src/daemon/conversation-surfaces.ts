import { v4 as uuid, v7 as uuidv7 } from "uuid";
import { z } from "zod";

import { SurfaceActionSchema } from "../api/events/ui-surface-show.js";
import {
  CardSurfaceDataSchema,
  FileUploadSurfaceDataSchema,
} from "../api/surfaces.js";
import {
  addAppConversationId,
  getApp,
  getAppDirPath,
  getAppPreview,
  listAppsByConversation,
  resolveAppDir,
  resolveEffectiveAppHtml,
  updateApp,
} from "../apps/app-store.js";
import { recordActivationEvent } from "../onboarding/onboarding-events-store.js";
import {
  getMessages,
  updateMessageContent,
} from "../persistence/conversation-crud.js";
import { isActivationSession } from "../plugins/defaults/memory/activation-session-store.js";
import {
  assistantEventHub,
  broadcastMessage,
} from "../runtime/assistant-event-hub.js";
import {
  ambiguousSameUserError,
  enforceSameActorOrErrorResult,
  pickSameUserAutoResolve,
} from "../runtime/auth/same-actor.js";
import type { AuthContext } from "../runtime/auth/types.js";
import type {
  InteractiveUiRequest,
  InteractiveUiResult,
} from "../runtime/interactive-ui-types.js";
import {
  activationMomentEmitsAtShow,
  type ActivationMomentParam,
  activationStepNameForMomentParam,
  isActivationMomentParam,
} from "../telemetry/activation-funnel.js";
import type { ToolExecutionResult } from "../tools/types.js";
import { getLogger } from "../util/logger.js";
import { isPlainObject } from "../util/object.js";
import { buildConversationErrorMessage } from "./conversation-error.js";
import { launchConversation } from "./conversation-launch.js";
import type { EnqueueMessageOptions } from "./conversation-messaging.js";
import type { ProcessMessageOptions } from "./conversation-process.js";
import type { HostAppControlProxy } from "./host-app-control-proxy.js";
import type { HostCuProxy } from "./host-cu-proxy.js";
import type {
  CardSurfaceData,
  ChoiceSurfaceData,
  ConfirmationSurfaceData,
  CopyBlockSurfaceData,
  DynamicPageSurfaceData,
  FileUploadSurfaceData,
  FormSurfaceData,
  ListSurfaceData,
  OAuthConnectSurfaceData,
  ServerMessage,
  SurfaceData,
  SurfaceType,
  TableColumn,
  TableRow,
  TableSurfaceData,
  UiSurfaceShow,
} from "./message-protocol.js";
import { INTERACTIVE_SURFACE_TYPES } from "./message-protocol.js";
import type { HostAppControlInput } from "./message-types/host-app-control.js";
import type { UserMessageAttachment } from "./message-types/shared.js";
import type { TrustContext } from "./trust-context-types.js";

const log = getLogger("conversation-surfaces");

// Tolerant variant of SurfaceActionSchema for parsing raw model output.
// The canonical schema rejects unknown style values; this one coerces them
// to "secondary" so a single mistyped style doesn't drop all actions.
const ModelActionSchema = SurfaceActionSchema.extend({
  style: z
    .enum(["primary", "secondary", "destructive"])
    .catch("secondary")
    .optional(),
});

const MAX_UNDO_DEPTH = 10;

/**
 * Debounce window for persisting `ui_surface_update` data back to the
 * message row. Surfaces typically receive bursts of updates (e.g. a
 * Workspace Health Check ticking off items rapidly) — collapsing them
 * to a single DB write avoids hammering SQLite while still bounding the
 * "lost work on crash" window to ~half a second.
 */
const SURFACE_PERSIST_DEBOUNCE_MS = 500;

/**
 * In-flight debounced persist timers keyed by `surfaceId`. Surface IDs
 * are UUIDs and globally unique, so a module-level map is safe across
 * conversations. Each entry holds the latest data snapshot — newer
 * updates clobber older ones since the persisted row carries the full
 * merged state, not a delta.
 */
const pendingSurfacePersists = new Map<
  string,
  {
    timer: ReturnType<typeof setTimeout>;
    conversationId: string;
    data: SurfaceData;
  }
>();

/**
 * Persist the latest `data` for a `ui_surface` content block by
 * scanning the conversation's messages for one containing the given
 * `surfaceId` and patching its `data` field. Mirrors the scan-and-patch
 * pattern in `markSurfaceCompleted`.
 *
 * Safe to call before the assistant message has been persisted (mid-stream):
 * the scan simply finds nothing and bails. The next update after
 * `handleMessageComplete` runs will pick up the now-persisted row.
 */
function persistSurfaceData(
  conversationId: string,
  surfaceId: string,
  data: SurfaceData,
): void {
  try {
    const rows = getMessages(conversationId);
    for (let r = rows.length - 1; r >= 0; r--) {
      const parsed: unknown[] = rows[r].content;
      let found = false;
      for (const pb of parsed) {
        const rb = pb as Record<string, unknown>;
        if (rb.type === "ui_surface" && rb.surfaceId === surfaceId) {
          rb.data = data;
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
    log.debug(
      { err, surfaceId, conversationId },
      "Failed to persist surface data update",
    );
  }
}

/**
 * Schedule a debounced write of the merged surface data back to the
 * persisted message row. Repeated calls within the debounce window
 * collapse to a single write carrying the latest data.
 */
export function scheduleSurfaceDataPersist(
  conversationId: string,
  surfaceId: string,
  data: SurfaceData,
): void {
  const existing = pendingSurfacePersists.get(surfaceId);
  if (existing) {
    clearTimeout(existing.timer);
  }
  const timer = setTimeout(() => {
    pendingSurfacePersists.delete(surfaceId);
    persistSurfaceData(conversationId, surfaceId, data);
  }, SURFACE_PERSIST_DEBOUNCE_MS);
  pendingSurfacePersists.set(surfaceId, { timer, conversationId, data });
}

/**
 * Force-flush any pending debounced persist for `surfaceId`. Called on
 * surface completion so the final state is durable before the surface
 * record transitions to `completed`.
 */
export function flushSurfaceDataPersist(surfaceId: string): void {
  const pending = pendingSurfacePersists.get(surfaceId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingSurfacePersists.delete(surfaceId);
  persistSurfaceData(pending.conversationId, surfaceId, pending.data);
}

/**
 * Discard (without writing) any pending debounced persist for `surfaceId`.
 * Called on dismissal so an in-flight `ui_update` snapshot cannot land after
 * the surface block has been removed.
 */
export function cancelSurfaceDataPersist(surfaceId: string): void {
  const pending = pendingSurfacePersists.get(surfaceId);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingSurfacePersists.delete(surfaceId);
}

/**
 * Cancel all pending debounced persists. Called on conversation
 * teardown to avoid timers firing against torn-down state.
 *
 * Use `flushPendingSurfaceDataPersists` instead on a clean shutdown
 * path where the latest in-flight surface state should still be
 * written before teardown.
 */
export function cancelPendingSurfaceDataPersists(
  conversationId?: string,
): void {
  for (const [surfaceId, pending] of pendingSurfacePersists) {
    if (conversationId && pending.conversationId !== conversationId) {
      continue;
    }
    clearTimeout(pending.timer);
    pendingSurfacePersists.delete(surfaceId);
  }
}

/**
 * Synchronously flush all pending debounced persists, optionally scoped
 * to a single conversation. Called on clean conversation teardown so an
 * update that arrived inside the 500ms debounce window still lands in
 * the DB before the conversation goes away. Each entry is removed from
 * the pending map after its write fires.
 */
export function flushPendingSurfaceDataPersists(conversationId?: string): void {
  for (const [surfaceId, pending] of pendingSurfacePersists) {
    if (conversationId && pending.conversationId !== conversationId) {
      continue;
    }
    clearTimeout(pending.timer);
    pendingSurfacePersists.delete(surfaceId);
    persistSurfaceData(pending.conversationId, surfaceId, pending.data);
  }
}

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
  // Force-flush any pending debounced data persist so the completion
  // patch lands on top of the latest data instead of racing with it.
  flushSurfaceDataPersist(surfaceId);

  // Update in-memory messages when available so subsequent reads within
  // this session see the change without waiting for DB.
  if (ctx.messages) {
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const msg = ctx.messages[i];
      if (!Array.isArray(msg.content)) {
        continue;
      }
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
      const parsed: unknown[] = rows[r].content;
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

/**
 * Complete a `ui_surface` card and notify live clients, addressed only by
 * conversation + surface id.
 *
 * Unlike {@link completeSurfaceFromAction}, this needs no live `Conversation`
 * instance, so it can run from flows that don't own one — projecting a
 * terminal guardian-request status onto its in-app approval card when the
 * request was resolved on another surface (or by the expiry sweep). Persists
 * the completion (reload-safe) and broadcasts `ui_surface_complete` so every
 * connected client of this guardian converges. No-ops when the surface block
 * isn't found in the conversation.
 */
export function completeSurfaceAndNotify(
  conversationId: string,
  surfaceId: string,
  summary: string,
): void {
  markSurfaceCompleted({ conversationId }, surfaceId, summary);
  broadcastMessage({
    type: "ui_surface_complete",
    conversationId,
    surfaceId,
    summary,
  });
}

/**
 * Remove a `ui_surface` content block from history so a passively dismissed
 * surface does not survive a reload. The live client drops a dismissed surface
 * entirely; this converges persisted state with that behaviour. Cancels any
 * pending debounced data persist first so a late `ui_update` snapshot cannot
 * re-add the block, then strips the block from in-memory messages and the DB.
 */
export function removeSurfaceBlock(
  ctx: { conversationId: string; messages?: Array<{ content: unknown }> },
  surfaceId: string,
): void {
  cancelSurfaceDataPersist(surfaceId);

  if (ctx.messages) {
    for (let i = ctx.messages.length - 1; i >= 0; i--) {
      const msg = ctx.messages[i];
      if (!Array.isArray(msg.content)) {
        continue;
      }
      const idx = msg.content.findIndex((block) => {
        const b = block as Record<string, unknown>;
        return b.type === "ui_surface" && b.surfaceId === surfaceId;
      });
      if (idx !== -1) {
        msg.content.splice(idx, 1);
        break;
      }
    }
  }

  try {
    const rows = getMessages(ctx.conversationId);
    for (let r = rows.length - 1; r >= 0; r--) {
      const parsed: unknown[] = rows[r].content;
      const idx = parsed.findIndex((pb) => {
        const rb = pb as Record<string, unknown>;
        return rb.type === "ui_surface" && rb.surfaceId === surfaceId;
      });
      if (idx !== -1) {
        parsed.splice(idx, 1);
        updateMessageContent(rows[r].id, JSON.stringify(parsed));
        return;
      }
    }
  } catch (err) {
    log.warn({ err, surfaceId }, "Failed to remove dismissed surface from DB");
  }
}
const TASK_PROGRESS_TEMPLATE_FIELDS = ["title", "status", "steps"] as const;

const TASK_PROGRESS_CARD_STATUSES = new Set([
  "in_progress",
  "completed",
  "failed",
]);
const TASK_PROGRESS_STEP_STATUSES = new Set([
  "pending",
  "in_progress",
  "completed",
  "failed",
]);

/**
 * Coerce a model-supplied `steps` value into a renderable array. Drops
 * non-object and label-less entries, accepts `title` as a `label` alias, and
 * defaults a missing/invalid per-step status to "pending". Returns `[]` for a
 * missing or non-array input so an indeterminate card still renders.
 */
function normalizeTaskProgressSteps(
  value: unknown,
): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((step): step is Record<string, unknown> => isPlainObject(step))
    .map((step) => {
      const label =
        typeof step.label === "string"
          ? step.label
          : typeof step.title === "string"
            ? step.title
            : "";
      const status =
        typeof step.status === "string" &&
        TASK_PROGRESS_STEP_STATUSES.has(step.status)
          ? step.status
          : "pending";
      return { ...step, label, status };
    })
    .filter((step) => (step.label as string).trim().length > 0);
}

/**
 * Guarantee a task_progress card reaches the client with a well-formed
 * `templateData` object so a coarse or indeterminate attempt (missing steps,
 * missing status) renders instead of being silently dropped. Fills only
 * missing fields — a fully-specified card is left intact.
 */
function ensureTaskProgressTemplateData(
  normalized: Record<string, unknown>,
): void {
  const templateData: Record<string, unknown> = isPlainObject(
    normalized.templateData,
  )
    ? { ...normalized.templateData }
    : {};
  if (
    typeof templateData.title !== "string" &&
    typeof normalized.title === "string"
  ) {
    templateData.title = normalized.title;
  }
  if (
    typeof templateData.status !== "string" ||
    !TASK_PROGRESS_CARD_STATUSES.has(templateData.status)
  ) {
    templateData.status = "in_progress";
  }
  templateData.steps = normalizeTaskProgressSteps(templateData.steps);
  normalized.templateData = templateData;
}

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

/** First entry that is a non-empty (trimmed) string, else undefined. */
function firstNonEmptyString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

/** All non-empty (trimmed) strings from the values list. */
function allNonEmptyStrings(values: unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      result.push(value);
    }
  }
  return result;
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

  // The model sees every surface type's schema in the ui_show tool description,
  // so it frequently borrows keys from sibling surfaces when emitting a card.
  // Recover those into the canonical card fields, checking both data-level and
  // top-level (input) placement. Multiple matches are concatenated (body) or
  // first-wins (title/subtitle); all alias keys are deleted afterward so they
  // don't appear as droppedKeys noise.
  //
  // body aliases: copy_block's `text`, confirmation's `message`, generic
  // `content`, and cross-surface `description` (choice/form/oauth/work_result/
  // dynamic_page — 5 types use it), work_result's `summary`, confirmation's
  // `detail`.
  const bodyAliasKeys = [
    "text",
    "message",
    "content",
    "description",
    "summary",
    "detail",
  ] as const;
  if (typeof normalized.body !== "string" || normalized.body.trim() === "") {
    const candidates = allNonEmptyStrings(
      bodyAliasKeys.map((k) => {
        const dataVal = normalized[k];
        if (typeof dataVal === "string" && dataVal.trim().length > 0) {
          return dataVal;
        }
        return input[k];
      }),
    );
    if (candidates.length > 0) {
      // Temporary: concatenate all matching aliases so no content is lost.
      // A future pass should define per-alias semantic roles (e.g. summary
      // as a subtitle, detail as supplementary) once production telemetry
      // reveals which combinations actually occur.
      normalized.body = candidates.join("\n\n");
    }
  }
  for (const key of bodyAliasKeys) {
    delete normalized[key];
  }

  // title aliases: natural synonyms the model reaches for when it doesn't
  // use `title` verbatim.
  const titleAliasKeys = ["heading", "header", "name"] as const;
  if (typeof normalized.title !== "string" || normalized.title.trim() === "") {
    const aliased = firstNonEmptyString([
      ...titleAliasKeys.map((k) => normalized[k]),
      ...titleAliasKeys.map((k) => input[k]),
    ]);
    if (aliased !== undefined) {
      normalized.title = aliased;
    }
  }
  for (const key of titleAliasKeys) {
    delete normalized[key];
  }

  // subtitle aliases: table's `caption`, natural synonym `subheading`.
  if (
    typeof normalized.subtitle !== "string" &&
    typeof input.subtitle === "string"
  ) {
    normalized.subtitle = input.subtitle;
  }
  const subtitleAliasKeys = ["subheading", "caption"] as const;
  if (
    typeof normalized.subtitle !== "string" ||
    normalized.subtitle.trim() === ""
  ) {
    const aliased = firstNonEmptyString([
      ...subtitleAliasKeys.map((k) => normalized[k]),
      ...subtitleAliasKeys.map((k) => input[k]),
    ]);
    if (aliased !== undefined) {
      normalized.subtitle = aliased;
    }
  }
  for (const key of subtitleAliasKeys) {
    delete normalized[key];
  }

  if (!Array.isArray(normalized.metadata) && Array.isArray(input.metadata)) {
    normalized.metadata = input.metadata;
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

  if (normalized.template === "task_progress") {
    ensureTaskProgressTemplateData(normalized);
  }

  // Parse, don't assert. The old `as unknown as CardSurfaceData` accepted any
  // shape, so anything the model nested under an unmodelled key was carried
  // through unread. Parsing draws the boundary; the dropped-key log surfaces
  // the shapes we still don't recover, so the recovery list above can grow from
  // real traffic rather than guesswork.
  const droppedKeys = Object.keys(normalized).filter(
    (key) => !(key in CardSurfaceDataSchema.shape),
  );
  if (droppedKeys.length > 0) {
    log.warn(
      { droppedKeys },
      "ui_show card data carried keys the card contract does not model; their content will not render",
    );
  }
  const parsed = CardSurfaceDataSchema.safeParse(normalized);
  if (parsed.success) {
    return parsed.data;
  }
  log.warn(
    { issues: parsed.error.issues },
    "ui_show card data failed CardSurfaceDataSchema; rendering only the fields that validated",
  );
  return CardSurfaceDataSchema.parse({
    title: typeof normalized.title === "string" ? normalized.title : undefined,
    subtitle:
      typeof normalized.subtitle === "string" ? normalized.subtitle : undefined,
    body: typeof normalized.body === "string" ? normalized.body : undefined,
  });
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

function normalizeChoiceShowData(
  rawData: Record<string, unknown>,
): ChoiceSurfaceData {
  const options = Array.isArray(rawData.options)
    ? rawData.options
        .filter((option): option is Record<string, unknown> =>
          isPlainObject(option),
        )
        .map((option) => {
          const id = typeof option.id === "string" ? option.id.trim() : "";
          const title =
            typeof option.title === "string"
              ? option.title.trim()
              : typeof option.label === "string"
                ? option.label.trim()
                : "";
          if (!id || !title) {
            return null;
          }
          return {
            id,
            title,
            ...(typeof option.description === "string"
              ? { description: option.description }
              : {}),
            ...(option.recommended === true ? { recommended: true } : {}),
            ...(isPlainObject(option.data)
              ? { data: option.data as Record<string, unknown> }
              : {}),
          };
        })
        .filter(
          (option): option is NonNullable<typeof option> => option !== null,
        )
    : [];

  return {
    ...(typeof rawData.description === "string"
      ? { description: rawData.description }
      : {}),
    options,
    selectionMode: rawData.selectionMode === "multiple" ? "multiple" : "single",
    ...(typeof rawData.submitLabel === "string"
      ? { submitLabel: rawData.submitLabel }
      : {}),
    ...(typeof rawData.commitOnSelect === "boolean"
      ? { commitOnSelect: rawData.commitOnSelect }
      : {}),
  };
}

function normalizeCopyBlockShowData(
  rawData: Record<string, unknown>,
): CopyBlockSurfaceData {
  return {
    text: typeof rawData.text === "string" ? rawData.text : "",
    ...(typeof rawData.label === "string" ? { label: rawData.label } : {}),
    ...(typeof rawData.language === "string"
      ? { language: rawData.language }
      : {}),
  };
}

function normalizeOAuthConnectShowData(
  rawData: Record<string, unknown>,
): OAuthConnectSurfaceData {
  return {
    providerKey:
      typeof rawData.providerKey === "string" ? rawData.providerKey.trim() : "",
    ...(typeof rawData.displayName === "string"
      ? { displayName: rawData.displayName }
      : {}),
    ...(typeof rawData.description === "string"
      ? { description: rawData.description }
      : {}),
    ...(typeof rawData.logoUrl === "string" || rawData.logoUrl === null
      ? { logoUrl: rawData.logoUrl }
      : {}),
  };
}

function normalizeFileUploadShowData(
  rawData: Record<string, unknown>,
): FileUploadSurfaceData {
  // Parse against the canonical schema so the surface carries the shape the
  // renderer expects. The schema is tolerant (every field optional and coerced)
  // and recovers the common malformed `acceptedTypes` shapes — a comma-joined or
  // bare string — into the `string[]` the renderer requires.
  const parsed = FileUploadSurfaceDataSchema.safeParse(rawData);
  if (parsed.success) {
    return parsed.data;
  }
  log.warn(
    { issues: parsed.error.issues },
    "ui_show file_upload data failed FileUploadSurfaceDataSchema; rendering an empty file_upload surface",
  );
  return {};
}

function buildChoiceActions(data: ChoiceSurfaceData): Array<{
  id: string;
  label: string;
  style?: string;
  data?: Record<string, unknown>;
}> {
  return data.options.map((option) => ({
    id: option.id,
    label: option.title,
    style: option.recommended ? "primary" : "secondary",
    data: {
      choiceId: option.id,
      choiceTitle: option.title,
      selectedIds: [option.id],
      selectedTitles: [option.title],
      ...(option.description ? { choiceDescription: option.description } : {}),
      ...(option.recommended ? { recommended: true } : {}),
      ...(option.data ?? {}),
    },
  }));
}

function isTaskProgressCardData(data: SurfaceData | Record<string, unknown>) {
  return (data as Record<string, unknown>).template === "task_progress";
}

function isSlackTaskProgressUiException(
  ctx: SurfaceConversationContext,
  toolName: string,
  input: Record<string, unknown>,
): boolean {
  if (ctx.channelCapabilities?.channel !== "slack") {
    return false;
  }
  if (toolName === "ui_show") {
    const surfaceType = input.surface_type as SurfaceType;
    if (surfaceType !== "card") {
      return false;
    }
    const rawData = isPlainObject(input.data) ? input.data : {};
    const data = normalizeCardShowData(input, rawData);
    return isTaskProgressCardData(data);
  }
  if (toolName === "ui_update") {
    const surfaceId = input.surface_id;
    if (typeof surfaceId !== "string") {
      return false;
    }
    const stored = ctx.surfaceState.get(surfaceId);
    if (!stored || stored.surfaceType !== "card") {
      return false;
    }
    if (!isTaskProgressCardData(stored.data)) {
      return false;
    }
    const rawPatch = isPlainObject(input.data) ? input.data : {};
    const patch = normalizeTaskProgressCardPatch(
      stored.data as CardSurfaceData,
      rawPatch,
    );
    const mergedData = { ...stored.data, ...patch } as SurfaceData;
    return isTaskProgressCardData(mergedData);
  }
  return false;
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
  /** Verified requester auth context for the active turn. */
  readonly authContext?: AuthContext;
  /** Per-turn auth snapshot, preferred for tool dispatch authorization. */
  readonly currentTurnAuthContext?: AuthContext;
  /** JWT-verified requester principal for the active turn. */
  readonly currentTurnSourceActorPrincipalId?: string;
  readonly channelCapabilities?: {
    channel: string;
    supportsDynamicUi: boolean;
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
      /**
       * Activation-rail telemetry tag (daemon-only). When the model tags a
       * `ui_show` surface as an activation funnel moment, the token is captured
       * here so the milestone can be recorded deterministically when the user
       * commits the surface (`handleSurfaceAction`). Never forwarded to the
       * client.
       */
      activationMoment?: ActivationMomentParam;
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
    toolCallId?: string;
    /**
     * Commit-timing activation-rail tag (daemon-only). Carried through to the
     * persisted `ui_surface` history block so it survives a reload — never sent
     * to the client.
     */
    activationMoment?: ActivationMomentParam;
  }>;
  /** Optional proxy for delegating computer-use actions to a connected desktop client. */
  hostCuProxy?: HostCuProxy;
  /** Optional proxy for delegating per-app app-control actions to a connected desktop client. */
  hostAppControlProxy?: HostAppControlProxy;
  /**
   * Setter that lets the resolver detach the conversation's app-control proxy
   * after `app_control_stop`. Disposes the existing proxy when transitioning
   * to undefined so subsequent tool calls cleanly fail with "unavailable"
   * rather than dispatching to a torn-down proxy.
   */
  setHostAppControlProxy?(proxy: HostAppControlProxy | undefined): void;
  /** True when no interactive client is connected (headless / channel-only). */
  readonly hasNoClient?: boolean;
  isProcessing(): boolean;
  enqueueMessage(options: EnqueueMessageOptions): {
    queued: boolean;
    requestId: string;
    rejected?: boolean;
  };
  getQueueDepth(): number;
  processMessage(options: ProcessMessageOptions): Promise<string>;
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
  if (ctx.hasNoClient) {
    return false;
  }
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
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const tombstoneTimer = setTimeout(() => {
      ctx.recentlyCompletedStandaloneSurfaces?.delete(surfaceId);
    }, STANDALONE_TOMBSTONE_TTL_MS);
    ctx.recentlyCompletedStandaloneSurfaces.set(surfaceId, tombstoneTimer);
  }
}

/**
 * How long to wait for a client to acknowledge an `open_panel` command
 * before reporting failure to the model. The ack round-trip is one SSE
 * delivery plus one HTTP POST, so this is generous — it only elapses when
 * no connected client rendered the panel (event dropped, no client
 * listening, or a client build that predates panel acknowledgment).
 */
const OPEN_PANEL_ACK_TIMEOUT_MS = 10_000;

/**
 * Open the channel-setup drawer on a connected client and wait for the
 * client's acknowledgment.
 *
 * `open_panel` is a side-effect-only command: it is never persisted to the
 * transcript, so a dropped event is unrecoverable by reload. The ack is what
 * makes the emitting tool result truthful — "displayed" must mean a client
 * actually rendered the drawer, not merely that the event was emitted.
 *
 * Reuses the standalone-surface pending machinery: the client responds via
 * the existing surface-action route (`actionId: "ack"` on success, `"nack"`
 * with `data.reason` when it received the event but could not open the
 * panel), which `handleSurfaceAction` intercepts and resolves without an
 * LLM turn. The surface-state entry exists only so the surface-action route
 * can resolve the owning conversation by `surfaceId`; `cleanupStandaloneSurface`
 * removes it on every outcome.
 */
export function openChannelSetupPanel(
  ctx: SurfaceConversationContext,
  surfaceId: string,
  data: Record<string, unknown>,
  options?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<InteractiveUiResult> {
  if (!canShowInteractiveUi(ctx) || !ctx.pendingStandaloneSurfaces) {
    log.warn(
      {
        conversationId: ctx.conversationId,
        hasNoClient: ctx.hasNoClient,
        channel: ctx.channelCapabilities?.channel,
      },
      "channel_setup panel: no interactive UI capability; failing closed",
    );
    return Promise.resolve({
      status: "cancelled" as const,
      surfaceId,
      cancellationReason: "no_interactive_surface" as const,
    });
  }
  const pendingMap = ctx.pendingStandaloneSurfaces;
  const signal = options?.signal;
  const timeoutMs = options?.timeoutMs ?? OPEN_PANEL_ACK_TIMEOUT_MS;

  if (signal?.aborted) {
    return Promise.resolve({
      status: "cancelled" as const,
      surfaceId,
      cancellationReason: "resolver_unavailable" as const,
    });
  }

  return new Promise<InteractiveUiResult>((resolve) => {
    const settle = (result: InteractiveUiResult) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      cleanupStandaloneSurface(ctx, surfaceId);
      log.warn(
        { conversationId: ctx.conversationId, surfaceId, timeoutMs },
        "channel_setup panel: no client acknowledged open_panel",
      );
      settle({ status: "timed_out", surfaceId });
    }, timeoutMs);

    const onAbort = () => {
      cleanupStandaloneSurface(ctx, surfaceId);
      settle({
        status: "cancelled",
        surfaceId,
        cancellationReason: "resolver_unavailable",
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    pendingMap.set(surfaceId, {
      resolve: settle,
      timer,
      surfaceType: "channel_setup",
    });
    // Registered so the surface-action route's by-surfaceId conversation
    // lookup finds this conversation when the ack arrives without a
    // conversationId. Cleared by cleanupStandaloneSurface on all outcomes.
    ctx.surfaceState.set(surfaceId, {
      surfaceType: "channel_setup",
      data: data as SurfaceData,
    });

    ctx.sendToClient({
      type: "open_panel",
      panelType: "channel_setup",
      data,
      conversationId: ctx.conversationId,
      surfaceId,
    });
  });
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
      if (s.surfaceType !== "dynamic_page") {
        continue;
      }
      const sData = s.data as DynamicPageSurfaceData;
      if (sData.appId !== data.appId) {
        continue;
      }
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
      if (sid === surfaceId) {
        continue;
      }
      if (s.surfaceType !== "dynamic_page") {
        continue;
      }
      const sData = s.data as DynamicPageSurfaceData;
      if (sData.appId !== data.appId) {
        continue;
      }

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
  if (columns.length === 0) {
    return row.id;
  }
  const firstColId = columns[0].id;
  const cell = row.cells[firstColId];
  if (cell == null) {
    return row.id;
  }
  if (typeof cell === "string") {
    return cell;
  }
  return cell.text;
}

const MAX_DESELECTION_ITEMS = 20;

/** Format a list of deselected item labels as a bullet list, capped at MAX_DESELECTION_ITEMS. */
export function formatDeselectionList(labels: string[]): string {
  if (labels.length === 0) {
    return "";
  }
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
  if (!surfaceState) {
    return "";
  }
  const selectedSet = new Set(selectedIds);

  if (surfaceType === "table" && surfaceState.surfaceType === "table") {
    const tableData = surfaceState.data as TableSurfaceData;
    const deselectedLabels: string[] = [];
    for (const row of tableData.rows) {
      if (row.selectable === false) {
        continue;
      }
      if (!selectedSet.has(row.id)) {
        deselectedLabels.push(describeTableRow(row, tableData.columns));
      }
    }
    if (deselectedLabels.length === 0) {
      return "";
    }
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
    if (deselectedLabels.length === 0) {
      return "";
    }
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

const SURFACE_COMPLETE_FLAG = "_completeSurface";
const SURFACE_COMPLETION_SUMMARY_FIELD = "_completionSummary";

function getRequestedSurfaceCompletionSummary(
  data?: Record<string, unknown>,
): string | null {
  if (data?.[SURFACE_COMPLETE_FLAG] !== true) {
    return null;
  }
  const summary =
    typeof data[SURFACE_COMPLETION_SUMMARY_FIELD] === "string"
      ? data[SURFACE_COMPLETION_SUMMARY_FIELD].trim()
      : "";
  return summary || "Completed";
}

/**
 * Best-effort recorder for a single activation-funnel moment. Gated on the
 * conversation being a marked activation-rail session. Fire-and-forget: never
 * throws, never blocks or alters the surface-action flow (a failure is logged
 * and swallowed). Shared by the show-time path (`first_wow_executed`, recorded
 * when the surface renders) and the commit-time path (the other moments,
 * recorded when the user commits the surface).
 */
function recordActivationMoment(
  ctx: SurfaceConversationContext,
  moment: ActivationMomentParam,
): void {
  try {
    if (!isActivationSession(ctx.conversationId)) {
      return;
    }
    recordActivationEvent({
      stepName: activationStepNameForMomentParam(moment),
      sessionId: ctx.conversationId,
    });
  } catch (err) {
    log.warn(
      { err, conversationId: ctx.conversationId, moment },
      "Failed to record activation moment",
    );
  }
}

/**
 * Best-effort activation-funnel emission on a user surface commit.
 *
 * When the committed surface carries a commit-timing `activationMoment` tag,
 * record the corresponding funnel milestone. Show-timing moments
 * (`first_wow_executed`) are recorded at render time in `surfaceProxyResolver`
 * and are NOT stored on `surfaceState`, so they never reach this path. The tag
 * is cleared after the first record so re-entrant or repeated commits on the
 * same surface do not double-emit (and the deterministic `daemon_event_id`
 * collapses any cross-surface duplicate downstream anyway).
 *
 * Must be called only from terminal-commit paths (user clicked an action /
 * submitted / selected-and-committed), NOT from intermediate non-terminal
 * events (`selection_changed` / `content_changed` / `state_update`).
 */
function maybeEmitActivationMoment(
  ctx: SurfaceConversationContext,
  surfaceId: string,
): void {
  const stored = ctx.surfaceState.get(surfaceId);
  const moment = stored?.activationMoment;
  if (!moment) {
    return;
  }
  // Clear the tag first so this can fire at most once per surface even if the
  // commit path is re-entered.
  stored.activationMoment = undefined;
  recordActivationMoment(ctx, moment);
}

function completeSurfaceFromAction(
  ctx: SurfaceConversationContext,
  surfaceId: string,
  summary: string,
): void {
  broadcastMessage({
    type: "ui_surface_complete",
    conversationId: ctx.conversationId,
    surfaceId,
    summary,
  });
  markSurfaceCompleted(ctx, surfaceId, summary);
}

// One-shot interactive surfaces auto-complete once their action message is
// accepted (they never accept further actions).
const ONE_SHOT_SURFACE_TYPES = [
  "choice",
  "oauth_connect",
  "form",
  "confirmation",
  "file_upload",
  "task_preferences",
];

export async function handleSurfaceAction(
  ctx: SurfaceConversationContext,
  surfaceId: string,
  actionId: string,
  data?: Record<string, unknown>,
  // JWT-verified committer principal; threaded so enqueued turns can
  // reconstruct the same-user binding for host proxies (CU / app-control),
  // mirroring the normal message path.
  sourceActorPrincipalId?: string,
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

    // channel_setup pendings are protocol-level acknowledgments for the
    // `open_panel` command, not user-facing surfaces: nothing was rendered
    // in the transcript, so there is no completion to broadcast, persist,
    // or count as an activation commit. Resolve and clean up only.
    if (standalone.surfaceType === "channel_setup") {
      cleanupStandaloneSurface(ctx, surfaceId);
      standalone.resolve(result);
      log.info(
        { conversationId: ctx.conversationId, surfaceId, actionId, status },
        "open_panel acknowledgment resolved",
      );
      return { accepted: true, conversationId: ctx.conversationId };
    }

    broadcastMessage({
      type: "ui_surface_complete",
      conversationId: ctx.conversationId,
      surfaceId,
      summary,
      submittedData: data,
    });
    markSurfaceCompleted(ctx, surfaceId, summary);

    // Terminal user commit on a standalone surface (submit, not cancel/dismiss)
    // — record an activation milestone if tagged. Must run before
    // `cleanupStandaloneSurface` clears the surface state.
    if (!isCancellation) {
      maybeEmitActivationMoment(ctx, surfaceId);
    }

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
    // Launching a child conversation is a terminal user commit — record an
    // activation milestone if tagged. The helper clears the tag after firing,
    // so the other commit-path call sites below can't double-emit.
    maybeEmitActivationMoment(ctx, surfaceId);
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
    const stored = ctx.surfaceState.get(surfaceId);
    const actionDef = stored?.actions?.find((a) => a.id === actionId);
    const mergedData: Record<string, unknown> | undefined =
      actionDef?.data || data ? { ...actionDef?.data, ...data } : undefined;

    const isRelay = actionId === "relay_prompt" || actionId === "agent_prompt";
    const prompt =
      isRelay && typeof mergedData?.prompt === "string"
        ? mergedData.prompt.trim()
        : "";

    // Read accumulated state once — used by both relay and custom action paths.
    const accState = ctx.accumulatedSurfaceState.get(surfaceId);
    const hasAccState = accState && Object.keys(accState).length > 0;

    // Extract file attachments from action data so they are sent as proper
    // image/file content blocks instead of dumping base64 into the text.
    let attachments: UserMessageAttachment[] = [];
    let actionDataForText = mergedData;
    if (mergedData && Array.isArray(mergedData.files)) {
      const files = mergedData.files as Array<Record<string, unknown>>;
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
        const { files: _files, ...rest } = mergedData;
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

    const requestId = uuidv7();
    ctx.surfaceActionRequestIds.add(requestId);
    // Pass conversationId so events without an inline conversationId (e.g.
    // text_delta) are published with the correct conversation scope and
    // reach the SSE subscriber filtered to this conversation.
    const onEvent = (msg: ServerMessage) =>
      broadcastMessage(msg, ctx.conversationId);

    const result = ctx.enqueueMessage({
      content,
      attachments,
      onEvent,
      requestId,
      activeSurfaceId: surfaceId,
      displayContent,
      sourceActorPrincipalId,
    });

    if (result.rejected) {
      ctx.surfaceActionRequestIds.delete(requestId);
      return;
    }

    // Terminal user commit accepted — record the activation milestone if this
    // surface was tagged (best-effort, no-op otherwise). Deferred until after
    // the rejection check so a queue-full click doesn't over-report a moment
    // (and the one-shot tag stays intact for the user's retry).
    maybeEmitActivationMoment(ctx, surfaceId);

    const requestedCompletionSummary =
      getRequestedSurfaceCompletionSummary(mergedData);
    if (requestedCompletionSummary) {
      completeSurfaceFromAction(ctx, surfaceId, requestedCompletionSummary);
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
      .processMessage({
        content,
        attachments,
        onEvent,
        requestId,
        activeSurfaceId: surfaceId,
        displayContent,
        sourceActorPrincipalId,
      })
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

  const requestId = uuidv7();
  ctx.surfaceActionRequestIds.add(requestId);
  // Pass conversationId so events without an inline conversationId (e.g.
  // text_delta) are published with the correct conversation scope and
  // reach the SSE subscriber filtered to this conversation.
  const onEvent = (msg: ServerMessage) =>
    broadcastMessage(msg, ctx.conversationId);

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

  const result = ctx.enqueueMessage({
    content,
    attachments: pendingAttachments,
    onEvent,
    requestId,
    activeSurfaceId: surfaceId,
    displayContent,
    sourceActorPrincipalId,
  });
  if (result.rejected) {
    ctx.surfaceActionRequestIds.delete(requestId);
    return;
  }

  // Terminal user commit accepted — record the activation milestone if this
  // surface was tagged (best-effort, no-op otherwise). Deferred until after the
  // rejection check so a queue-full click doesn't over-report a moment (and the
  // one-shot tag stays intact for the user's retry).
  maybeEmitActivationMoment(ctx, surfaceId);

  const requestedCompletionSummary =
    getRequestedSurfaceCompletionSummary(mergedData);

  // One-shot interactive surfaces — auto-complete now that the message has
  // been accepted. Deferred until after rejection check so the surface stays
  // active and retryable if the queue was full.
  if (
    requestedCompletionSummary ||
    ONE_SHOT_SURFACE_TYPES.includes(pending.surfaceType)
  ) {
    const completionSummary = requestedCompletionSummary ?? summary;
    broadcastMessage({
      type: "ui_surface_complete",
      conversationId: ctx.conversationId,
      surfaceId,
      summary: completionSummary,
      submittedData: mergedDataForText,
    });
    markSurfaceCompleted(ctx, surfaceId, completionSummary);
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
    .processMessage({
      content,
      attachments: pendingAttachments,
      onEvent,
      requestId,
      activeSurfaceId: surfaceId,
      displayContent,
      sourceActorPrincipalId,
    })
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
  if (!app) {
    return false;
  }

  let refreshed = false;
  for (const [surfaceId, stored] of ctx.surfaceState.entries()) {
    if (stored.surfaceType !== "dynamic_page") {
      continue;
    }
    const data = stored.data as DynamicPageSurfaceData;
    if (data.appId !== appId) {
      continue;
    }

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

/**
 * Strip a leading "Connect "/"Connected " verb from an OAuth provider label so
 * a supplied displayName like "Connect Gmail" doesn't double the verb when
 * prefixed (e.g. avoids "Connected Connect Gmail").
 */
function stripConnectVerb(label: string): string {
  return label.replace(/^connect(?:ed)?\s+/i, "");
}

export function buildCompletionSummary(
  surfaceType: string | undefined,
  actionId: string,
  data?: Record<string, unknown>,
  surfaceData?: Record<string, unknown>,
): string {
  const selectedTitles = Array.isArray(data?.selectedTitles)
    ? data.selectedTitles.filter(
        (title): title is string => typeof title === "string",
      )
    : [];

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
  if (surfaceType === "choice" && data) {
    const choiceTitle =
      typeof data.choiceTitle === "string" ? data.choiceTitle : undefined;
    if (choiceTitle) {
      return `User chose: "${choiceTitle}"`;
    }
    if (selectedTitles.length === 1) {
      return `User chose: "${selectedTitles[0]}"`;
    }
    if (selectedTitles.length > 1) {
      return `User chose ${selectedTitles.length} options: ${selectedTitles
        .map((title) => `"${title}"`)
        .join(", ")}`;
    }
    return `User chose: ${actionId}`;
  }
  if (surfaceType === "oauth_connect") {
    const providerLabel =
      typeof data?.providerLabel === "string"
        ? data.providerLabel
        : typeof data?.displayName === "string"
          ? data.displayName
          : typeof data?.providerKey === "string"
            ? data.providerKey
            : "OAuth";
    // Strip the verb once so every branch (connected/cancelled/failed/
    // fallback) is normalized — a displayName like "Connect Gmail" must not
    // produce "Cancelled Connect Gmail connection".
    const label = stripConnectVerb(providerLabel);
    const accountLabel =
      typeof data?.accountLabel === "string" ? data.accountLabel : undefined;
    if (actionId === "connect" || data?.status === "connected") {
      return accountLabel
        ? `Connected ${label}: ${accountLabel}`
        : `Connected ${label}`;
    }
    if (actionId === "cancel" || data?.status === "cancelled") {
      return `Cancelled ${label} connection`;
    }
    if (data?.status === "error") {
      return `${label} connection failed`;
    }
    return `${label} connection ${actionId}`;
  }
  if (surfaceType === "list" && data) {
    const selectedIds = data.selectedIds as string[] | undefined;
    const actionSuffix = actionId ? ` (action: ${actionId})` : "";
    if (selectedIds?.length === 1) {
      return `Selected: ${selectedIds[0]}${actionSuffix}`;
    }
    if (selectedIds?.length) {
      return `Selected ${selectedIds.length} items${actionSuffix}`;
    }
  }
  if (surfaceType === "table" && data) {
    const selectedIds = data.selectedIds as string[] | undefined;
    const actionSuffix = actionId ? ` (action: ${actionId})` : "";
    if (selectedIds?.length === 1) {
      return `Selected 1 row${actionSuffix}`;
    }
    if (selectedIds?.length) {
      return `Selected ${selectedIds.length} rows${actionSuffix}`;
    }
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
  const selectedTitles = Array.isArray(data?.selectedTitles)
    ? data.selectedTitles.filter(
        (title): title is string => typeof title === "string",
      )
    : [];

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
  if (surfaceType === "form") {
    return "Submitted";
  }
  if (surfaceType === "choice") {
    const choiceTitle =
      typeof data?.choiceTitle === "string" ? data.choiceTitle : undefined;
    if (choiceTitle) {
      return choiceTitle;
    }
    if (selectedTitles.length === 1) {
      return selectedTitles[0];
    }
    if (selectedTitles.length > 1) {
      return `Selected ${selectedTitles.length} options`;
    }
    return "Selected";
  }
  if (surfaceType === "oauth_connect") {
    const providerLabel =
      typeof data?.providerLabel === "string"
        ? data.providerLabel
        : typeof data?.displayName === "string"
          ? data.displayName
          : typeof data?.providerKey === "string"
            ? data.providerKey
            : "OAuth";
    // Strip the verb once so every branch is normalized (e.g. a displayName
    // like "Connect Gmail" must not produce "Connect Gmail connection failed").
    const label = stripConnectVerb(providerLabel);
    const accountLabel =
      typeof data?.accountLabel === "string" ? data.accountLabel : undefined;
    if (actionId === "connect" || data?.status === "connected") {
      return accountLabel
        ? `Connected ${label}: ${accountLabel}`
        : `Connected ${label}`;
    }
    if (actionId === "cancel" || data?.status === "cancelled") {
      return "Cancelled";
    }
    if (data?.status === "error") {
      return `${label} connection failed`;
    }
    return `Selected: ${actionId}`;
  }

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
  toolUseId?: string,
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
    let targetClientId: string | undefined =
      typeof input.target_client_id === "string" &&
      input.target_client_id !== ""
        ? input.target_client_id
        : undefined;

    // Validate targetClientId existence, capability, and same-user binding
    // before recordAction so an invalid or cross-user ID does not burn a
    // step or pollute action history. HostBashProxy / HostFileProxy
    // validate at the tool-resolution layer for the same reason. The proxy
    // re-checks same-user (single authoritative gate); using the shared
    // helper keeps log payload and error wording identical at both layers.
    const sourceActorPrincipalId =
      ctx.currentTurnSourceActorPrincipalId ??
      ctx.currentTurnAuthContext?.actorPrincipalId ??
      ctx.authContext?.actorPrincipalId;
    if (targetClientId != null) {
      const client = assistantEventHub.getClientById(targetClientId);
      if (!client) {
        return {
          content: `No connected client with id '${targetClientId}'. Run \`assistant clients list --capability host_cu\` to see available clients.`,
          isError: true,
        };
      }
      if (!client.capabilities.includes("host_cu")) {
        return {
          content: `Client '${targetClientId}' does not support host_cu. Run \`assistant clients list --capability host_cu\` to see available clients.`,
          isError: true,
        };
      }
      const rejection = enforceSameActorOrErrorResult({
        hub: assistantEventHub,
        sourceActorPrincipalId,
        targetClientId,
        op: "host_cu",
      });
      if (rejection) {
        return rejection;
      }
    }

    // Untargeted CU must resolve to exactly one same-user capable client
    // before dispatch. Otherwise the proxy would broadcast without a target
    // actor binding, which is unsafe in shared runtimes.
    if (targetClientId == null) {
      const resolved = pickSameUserAutoResolve({
        hub: assistantEventHub,
        capability: "host_cu",
        sourceActorPrincipalId,
      });
      if (resolved.kind === "ambiguous") {
        return ambiguousSameUserError("host_cu");
      }
      if (resolved.kind === "match") {
        targetClientId = resolved.clientId;
      } else if (
        assistantEventHub.listClientsByCapability("host_cu").length > 0
      ) {
        return {
          content:
            "Computer use is not available for the current actor. Connect a host_cu-capable client as the same user.",
          isError: true,
        };
      }
    }

    ctx.hostCuProxy.recordAction(toolName, input, reasoning);
    return ctx.hostCuProxy.request(
      toolName,
      input,
      ctx.conversationId,
      ctx.hostCuProxy.stepCount,
      reasoning,
      signal,
      targetClientId,
      sourceActorPrincipalId,
    );
  }

  // Route app-control proxy tools (all app_control_* tool variants)
  if (toolName.startsWith("app_control_")) {
    // `app_control_stop` resolves immediately: tear down the proxy without
    // a client round-trip. Mirrors CU's terminal-tool short-circuit
    // (`computer_use_done` / `computer_use_respond`). Clear the
    // conversation's reference (setter disposes the existing proxy) so a
    // later `app_control_observe`/etc. cleanly fails with "unavailable"
    // instead of dispatching against a torn-down proxy, and so a sibling
    // conversation can acquire the released singleton lock without the
    // disposed proxy still being addressable.
    //
    // Run this BEFORE the isAvailable() gate so a disconnected client
    // doesn't strand the singleton lock — stop is local-only.
    if (toolName === "app_control_stop") {
      if (ctx.hostAppControlProxy) {
        if (ctx.setHostAppControlProxy) {
          ctx.setHostAppControlProxy(undefined);
        } else {
          ctx.hostAppControlProxy.dispose();
        }
      }
      return { content: "App control stopped.", isError: false };
    }

    if (!ctx.hostAppControlProxy || !ctx.hostAppControlProxy.isAvailable()) {
      return {
        content:
          "App control is not available — enable the `app-control` feature flag and connect a macOS client.",
        isError: true,
      };
    }

    // Resolve target client. Mirrors the host_cu block above: validate
    // explicit target_client_id (existence, capability, same-actor), then
    // multi-client guard when no target is supplied. App-control is
    // single-client-only at the host (one active session per macOS
    // machine), so a broadcast across multiple capable clients would fire
    // the same input on every machine.
    let targetClientId: string | undefined =
      typeof input.target_client_id === "string" &&
      input.target_client_id !== ""
        ? input.target_client_id
        : undefined;

    const sourceActorPrincipalId =
      ctx.currentTurnSourceActorPrincipalId ??
      ctx.currentTurnAuthContext?.actorPrincipalId ??
      ctx.authContext?.actorPrincipalId;
    if (targetClientId != null) {
      const client = assistantEventHub.getClientById(targetClientId);
      if (!client) {
        return {
          content: `No connected client with id '${targetClientId}'. Run \`assistant clients list --capability host_app_control\` to see available clients.`,
          isError: true,
        };
      }
      if (!client.capabilities.includes("host_app_control")) {
        return {
          content: `Client '${targetClientId}' does not support host_app_control. Run \`assistant clients list --capability host_app_control\` to see available clients.`,
          isError: true,
        };
      }
      const rejection = enforceSameActorOrErrorResult({
        hub: assistantEventHub,
        sourceActorPrincipalId,
        targetClientId,
        op: "host_app_control",
      });
      if (rejection) {
        return rejection;
      }
    }

    if (targetClientId == null) {
      const resolved = pickSameUserAutoResolve({
        hub: assistantEventHub,
        capability: "host_app_control",
        sourceActorPrincipalId,
      });
      if (resolved.kind === "ambiguous") {
        return ambiguousSameUserError("host_app_control");
      }
      if (resolved.kind === "match") {
        targetClientId = resolved.clientId;
      } else if (
        assistantEventHub.listClientsByCapability("host_app_control").length > 0
      ) {
        return {
          content:
            "App control is not available for the current actor. Connect a host_app_control-capable client as the same user.",
          isError: true,
        };
      }
    }

    // The TS `HostAppControlInput` (and the Swift mirror) is a discriminated
    // union on `tool` ("start" | "observe" | "press" | …). The agent's raw
    // tool input only carries the action-specific payload (app, x/y, text,
    // …) — the discriminator is implied by `toolName` (`app_control_<tool>`).
    // Inject it here so the proxy's session-lock guard (`input.tool ===
    // "start"`) and the Swift client's discriminated-union decoder both see
    // the field they require.
    const tool = toolName.slice("app_control_".length);
    const inputWithTool = {
      ...input,
      tool,
    } as unknown as HostAppControlInput;

    return ctx.hostAppControlProxy.request(
      toolName,
      inputWithTool,
      ctx.conversationId,
      signal ?? new AbortController().signal,
      sourceActorPrincipalId,
      targetClientId,
    );
  }

  if (toolName === "ui_show" || toolName === "ui_update") {
    const caps = ctx.channelCapabilities;
    if (
      caps &&
      !caps.supportsDynamicUi &&
      !isSlackTaskProgressUiException(ctx, toolName, input)
    ) {
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

    // channel_setup is a side-effect-only command: it opens the channel setup
    // drawer on the client. Emitted as `open_panel` (not `ui_surface_show`)
    // so the rolling-snapshot reducer never folds it into the transcript.
    // Because the event is never persisted, success is gated on a client
    // acknowledgment — "displayed" must mean a client actually rendered the
    // drawer, otherwise the model announces a panel the user cannot see.
    if (surfaceType === "channel_setup") {
      const ack = await openChannelSetupPanel(
        ctx,
        surfaceId,
        rawData as Record<string, unknown>,
        { signal },
      );

      if (ack.status === "submitted" && ack.actionId === "ack") {
        return {
          content: JSON.stringify({ surfaceId, status: "displayed" }),
          isError: false,
        };
      }

      if (ack.status === "submitted") {
        // Client received the event but could not open the panel (nack).
        const reason =
          typeof ack.submittedData?.reason === "string"
            ? ack.submittedData.reason
            : "unknown";
        return {
          content: `The channel setup panel could not be opened by the connected client (reason: ${reason}). Do NOT tell the user the panel is open. Troubleshoot with the user (e.g. ask them to reopen or refresh the Vellum app), then retry ui_show.`,
          isError: true,
        };
      }

      if (ack.status === "timed_out") {
        return {
          content:
            "No connected client confirmed opening the channel setup panel. Do NOT tell the user the panel is open. The user's app may be closed, viewing a different conversation, or running a version that cannot show this panel. Ask the user to open this conversation in the Vellum app (web or desktop), then retry ui_show.",
          isError: true,
        };
      }

      // cancelled — no interactive client, or the turn was aborted.
      return {
        content:
          "The channel setup panel could not be opened — no connected client can render interactive UI. Do NOT tell the user the panel is open. Ask the user to open the Vellum app (web or desktop), then retry ui_show.",
        isError: true,
      };
    }

    // Each surface type that has a canonical Zod schema gets parsed through it;
    // the rest pass through raw until migrated (LUM-2134 scope). The per-type
    // normalizers validate+recover; the union cast at the end is only for the
    // unmigrated branches that still return hand-written interfaces.
    const cardData =
      surfaceType === "card"
        ? normalizeCardShowData(input, rawData)
        : undefined;
    const data: SurfaceData =
      cardData !== undefined
        ? cardData
        : surfaceType === "choice"
          ? normalizeChoiceShowData(rawData)
          : surfaceType === "copy_block"
            ? normalizeCopyBlockShowData(rawData)
            : surfaceType === "oauth_connect"
              ? normalizeOAuthConnectShowData(rawData)
              : surfaceType === "dynamic_page"
                ? normalizeDynamicPageShowData(input, rawData)
                : surfaceType === "file_upload"
                  ? normalizeFileUploadShowData(rawData)
                  : (rawData as SurfaceData);
    // Parse actions through the schema instead of typecasting raw model output.
    // The model may place actions inside `data` instead of the top-level
    // `actions` param — recover them so they aren't silently dropped.
    const rawActions = Array.isArray(input.actions)
      ? input.actions
      : Array.isArray(rawData.actions)
        ? rawData.actions
        : undefined;
    let inputActions: z.infer<typeof ModelActionSchema>[] | undefined;
    if (rawActions) {
      const valid: z.infer<typeof ModelActionSchema>[] = [];
      for (const raw of rawActions) {
        const result = ModelActionSchema.safeParse(raw);
        if (result.success) {
          valid.push(result.data);
        }
      }
      inputActions = valid.length > 0 ? valid : undefined;
    }
    const actions =
      surfaceType === "choice"
        ? buildChoiceActions(data as ChoiceSurfaceData)
        : inputActions;
    const hasActions = Array.isArray(actions) && actions.length > 0;
    if (surfaceType === "choice" && !hasActions) {
      return {
        content:
          "choice surfaces require at least one option with both id and title.",
        isError: true,
      };
    }
    if (cardData !== undefined) {
      const hasTitle =
        (typeof title === "string" && title.trim().length > 0) ||
        (typeof cardData.title === "string" &&
          cardData.title.trim().length > 0);
      const hasBody =
        typeof cardData.body === "string" && cardData.body.trim().length > 0;
      const hasSubtitle =
        typeof cardData.subtitle === "string" &&
        cardData.subtitle.trim().length > 0;
      const hasMetadata =
        Array.isArray(cardData.metadata) && cardData.metadata.length > 0;
      const hasTemplate = typeof cardData.template === "string";
      if (
        !hasTitle &&
        !hasBody &&
        !hasSubtitle &&
        !hasMetadata &&
        !hasTemplate &&
        !hasActions
      ) {
        return {
          content:
            "Error: ui_show card requires content — provide `data.body`, a `template` (e.g. task_progress with steps), `data.metadata`, `data.subtitle`, a `title`, or `actions`. The surface was not displayed because it carried no renderable content. Resend ui_show with populated card content.",
          isError: true,
        };
      }
    }
    const oauthProviderKey =
      surfaceType === "oauth_connect"
        ? (data as unknown as Record<string, unknown>).providerKey
        : undefined;
    if (
      surfaceType === "oauth_connect" &&
      (typeof oauthProviderKey !== "string" ||
        oauthProviderKey.trim().length === 0)
    ) {
      return {
        content: "oauth_connect surfaces require data.providerKey.",
        isError: true,
      };
    }

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
      style: a.style ?? "secondary",
      ...(a.data ? { data: a.data } : {}),
    }));

    // Optional activation-rail telemetry tag. Daemon-only metadata: validated
    // and ignored if invalid; never forwarded to the client.
    const activationMoment =
      typeof input.activation_moment === "string" &&
      isActivationMomentParam(input.activation_moment)
        ? input.activation_moment
        : undefined;

    // Show-timing moments (`first_wow_executed`) record the instant the surface
    // renders — a display-only result/`work_result` card may never be committed,
    // so a commit-time emit would never fire. We record now and do NOT store the
    // tag, so the commit path won't double-emit. Commit-timing moments are
    // stored and recorded when the user commits the surface (see
    // `handleSurfaceAction` → `maybeEmitActivationMoment`).
    const storeTagForCommit =
      activationMoment !== undefined &&
      !activationMomentEmitsAtShow(activationMoment);

    // Track surface state for ui_update merging (includes actions so we can
    // look up per-action data payloads when the client sends an action back).
    ctx.surfaceState.set(surfaceId, {
      surfaceType,
      data,
      title,
      actions: mappedActions,
      ...(storeTagForCommit ? { activationMoment } : {}),
    });

    if (activationMoment !== undefined && !storeTagForCommit) {
      recordActivationMoment(ctx, activationMoment);
    }

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
      ...(toolUseId ? { toolCallId: toolUseId } : {}),
    } as unknown as UiSurfaceShow);

    // Track surface for persistence with the message. The commit-timing
    // activation tag rides along (daemon-only) so it survives history restore;
    // show-timing moments aren't stored here (already recorded at render).
    ctx.currentTurnSurfaces.push({
      surfaceId,
      surfaceType,
      title,
      data,
      actions: mappedActions,
      display,
      ...(persistent ? { persistent: true } : {}),
      ...(toolUseId ? { toolCallId: toolUseId } : {}),
      ...(storeTagForCommit ? { activationMoment } : {}),
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
      const rawMerged = { ...stored.data, ...patch };
      if (stored.surfaceType === "card") {
        // Validate the merged card data through the canonical schema so
        // malformed patches (e.g. metadata as a string) are caught here
        // instead of crashing the client's safeParse.
        const parsed = CardSurfaceDataSchema.safeParse(rawMerged);
        mergedData = parsed.success
          ? parsed.data
          : (CardSurfaceDataSchema.safeParse(stored.data).data ?? {});
        if (!parsed.success) {
          log.warn(
            { surfaceId, issues: parsed.error.issues },
            "ui_update card patch produced invalid merged data; reverting to stored data",
          );
        }
      } else {
        // Other surface types lack canonical Zod schemas (LUM-2134 scope).
        // The raw merge is the best we can do until they're migrated.
        mergedData = rawMerged as SurfaceData;
      }
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

    // Persist the merged data back to the assistant message's
    // `ui_surface` content block so a refresh / restart shows the
    // current state instead of the original creation-time snapshot.
    // Debounced to coalesce bursts of rapid updates.
    scheduleSurfaceDataPersist(ctx.conversationId, surfaceId, mergedData);

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
      // The live client drops a dismissed surface entirely. Mirror that in
      // persisted state: pull it from the pending turn snapshot (appended to
      // the message at turn completion) and strip any already-persisted block,
      // so a reload does not resurrect a half-finished progress card.
      const turnIdx = ctx.currentTurnSurfaces.findIndex(
        (s) => s.surfaceId === surfaceId,
      );
      if (turnIdx !== -1) {
        ctx.currentTurnSurfaces.splice(turnIdx, 1);
      }
      removeSurfaceBlock(ctx, surfaceId);
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
    // Weaker models routinely omit app_id even though the active app is in
    // context. Fall back to the conversation's most-recently-updated app
    // rather than failing with "Invalid ID: undefined".
    let appId = input.app_id as string;
    if (typeof appId !== "string" || appId.trim().length === 0) {
      appId = listAppsByConversation(ctx.conversationId)[0]?.id ?? "";
    }
    const preview = input.preview as DynamicPageSurfaceData["preview"];
    const openMode = input.open_mode as string | undefined;
    const app = appId ? getApp(appId) : null;
    if (!app) {
      return {
        content: appId
          ? `App not found: ${appId}`
          : "app_id is required and no active app exists in this conversation. Call app_create first, or pass app_id explicitly.",
        isError: true,
      };
    }

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

    // Auto-compile if dist is missing, then resolve HTML from compiled
    // dist/index.html with inlined assets.
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
        ...(toolUseId ? { toolCallId: toolUseId } : {}),
      } as UiSurfaceShow);

      // Track for message persistence so the inline card survives history reload.
      ctx.currentTurnSurfaces.push({
        surfaceId,
        surfaceType: "dynamic_page",
        title: app.name,
        data: surfaceData,
        display: "inline",
        ...(toolUseId ? { toolCallId: toolUseId } : {}),
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
      ...(toolUseId ? { toolCallId: toolUseId } : {}),
    } as UiSurfaceShow);

    // Track surface for persistence
    ctx.currentTurnSurfaces.push({
      surfaceId,
      surfaceType: "dynamic_page",
      title: app.name,
      data: surfaceData,
      ...(toolUseId ? { toolCallId: toolUseId } : {}),
    });

    ctx.pendingSurfaceActions.set(surfaceId, { surfaceType: "dynamic_page" });

    return { content: JSON.stringify({ surfaceId, appId }), isError: false };
  }

  return { content: `Unknown proxy tool: ${toolName}`, isError: true };
}
