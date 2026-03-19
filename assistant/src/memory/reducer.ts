/**
 * Parsing and validation layer for the simplified memory reducer.
 *
 * This module owns the contract between the LLM's JSON output and the typed
 * ReducerResult. The actual provider call lives in a later PR — this file
 * only handles:
 *   1. ReducerPromptInput — what goes into the provider call
 *   2. parseReducerOutput — raw string -> validated ReducerResult
 *   3. Fallback to EMPTY_REDUCER_RESULT on any invalid output
 */

import { getLogger } from "../util/logger.js";
import {
  type ArchiveEpisodeCandidate,
  type ArchiveObservationCandidate,
  EMPTY_REDUCER_RESULT,
  type OpenLoopCreate,
  type OpenLoopOp,
  type OpenLoopUpdate,
  type ReducerResult,
  type TimeContextOp,
  type TimeContextUpdate,
} from "./reducer-types.js";

const log = getLogger("memory-reducer");

// ── Prompt input type ──────────────────────────────────────────────────

/** The structured input that will be fed to the reducer provider call. */
export interface ReducerPromptInput {
  /** Conversation ID being reduced. */
  conversationId: string;
  /** New messages since the last reduction checkpoint (role + content). */
  newMessages: Array<{ role: string; content: string }>;
  /** Current time-context rows the model can reference for updates. */
  existingTimeContexts: Array<{ id: string; summary: string }>;
  /** Current open-loop rows the model can reference for updates. */
  existingOpenLoops: Array<{ id: string; summary: string; status: string }>;
}

// ── Validation helpers ─────────────────────────────────────────────────

const VALID_TIME_CONTEXT_ACTIONS = new Set(["create", "update", "resolve"]);
const VALID_OPEN_LOOP_ACTIONS = new Set(["create", "update", "resolve"]);
const VALID_OPEN_LOOP_RESOLVE_STATUSES = new Set(["resolved", "expired"]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isPositiveNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

function isNonNegativeNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function validateTimeContextOp(raw: unknown): TimeContextOp | null {
  if (raw == null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const action = obj.action;

  if (!isNonEmptyString(action) || !VALID_TIME_CONTEXT_ACTIONS.has(action)) {
    return null;
  }

  if (action === "create") {
    if (
      !isNonEmptyString(obj.summary) ||
      !isNonEmptyString(obj.source) ||
      !isNonNegativeNumber(obj.activeFrom) ||
      !isPositiveNumber(obj.activeUntil)
    ) {
      return null;
    }
    return {
      action: "create",
      summary: obj.summary,
      source: obj.source,
      activeFrom: obj.activeFrom,
      activeUntil: obj.activeUntil,
    };
  }

  if (action === "update") {
    if (!isNonEmptyString(obj.id)) return null;
    // Extract and narrow optional fields
    const summary = isNonEmptyString(obj.summary) ? obj.summary : undefined;
    const activeFrom = isNonNegativeNumber(obj.activeFrom)
      ? obj.activeFrom
      : undefined;
    const activeUntil = isPositiveNumber(obj.activeUntil)
      ? obj.activeUntil
      : undefined;
    // At least one field must be provided for the update to be meaningful
    if (
      summary === undefined &&
      activeFrom === undefined &&
      activeUntil === undefined
    ) {
      return null;
    }
    const result: TimeContextUpdate = {
      action: "update",
      id: obj.id,
    };
    if (summary !== undefined) result.summary = summary;
    if (activeFrom !== undefined) result.activeFrom = activeFrom;
    if (activeUntil !== undefined) result.activeUntil = activeUntil;
    return result;
  }

  // resolve
  if (!isNonEmptyString(obj.id)) return null;
  return { action: "resolve", id: obj.id };
}

function validateOpenLoopOp(raw: unknown): OpenLoopOp | null {
  if (raw == null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const action = obj.action;

  if (!isNonEmptyString(action) || !VALID_OPEN_LOOP_ACTIONS.has(action)) {
    return null;
  }

  if (action === "create") {
    if (!isNonEmptyString(obj.summary) || !isNonEmptyString(obj.source)) {
      return null;
    }
    const result: OpenLoopCreate = {
      action: "create",
      summary: obj.summary,
      source: obj.source,
    };
    const dueAt = isNonNegativeNumber(obj.dueAt) ? obj.dueAt : undefined;
    if (dueAt !== undefined) result.dueAt = dueAt;
    return result;
  }

  if (action === "update") {
    if (!isNonEmptyString(obj.id)) return null;
    const summary = isNonEmptyString(obj.summary) ? obj.summary : undefined;
    const dueAt = isNonNegativeNumber(obj.dueAt) ? obj.dueAt : undefined;
    if (summary === undefined && dueAt === undefined) return null;

    const result: OpenLoopUpdate = {
      action: "update",
      id: obj.id,
    };
    if (summary !== undefined) result.summary = summary;
    if (dueAt !== undefined) result.dueAt = dueAt;
    return result;
  }

  // resolve
  if (!isNonEmptyString(obj.id)) return null;
  if (
    !isNonEmptyString(obj.status) ||
    !VALID_OPEN_LOOP_RESOLVE_STATUSES.has(obj.status)
  ) {
    return null;
  }
  return {
    action: "resolve",
    id: obj.id,
    status: obj.status as "resolved" | "expired",
  };
}

function validateArchiveObservation(
  raw: unknown,
): ArchiveObservationCandidate | null {
  if (raw == null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (!isNonEmptyString(obj.content) || !isNonEmptyString(obj.role)) {
    return null;
  }
  const result: ArchiveObservationCandidate = {
    content: obj.content,
    role: obj.role,
  };
  if (isNonEmptyString(obj.modality)) result.modality = obj.modality;
  if (isNonEmptyString(obj.source)) result.source = obj.source;
  return result;
}

function validateArchiveEpisode(raw: unknown): ArchiveEpisodeCandidate | null {
  if (raw == null || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (!isNonEmptyString(obj.title) || !isNonEmptyString(obj.summary)) {
    return null;
  }
  const result: ArchiveEpisodeCandidate = {
    title: obj.title,
    summary: obj.summary,
  };
  if (isNonEmptyString(obj.source)) result.source = obj.source;
  return result;
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Parse raw model output into a validated ReducerResult.
 *
 * On any structural error (non-JSON, missing top-level keys, wrong types)
 * the function returns EMPTY_REDUCER_RESULT rather than throwing. Individual
 * invalid operations within an otherwise valid structure are silently dropped
 * to preserve the rest of the result.
 *
 * However, if **all four** top-level arrays are absent or not arrays, the
 * entire output is treated as invalid and returns the empty result.
 */
export function parseReducerOutput(raw: string): ReducerResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn("reducer output is not valid JSON — falling back to empty result");
    return EMPTY_REDUCER_RESULT;
  }

  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn(
      "reducer output is not a JSON object — falling back to empty result",
    );
    return EMPTY_REDUCER_RESULT;
  }

  const obj = parsed as Record<string, unknown>;

  // Check that at least one top-level array key exists
  const hasTimeContexts = Array.isArray(obj.timeContexts);
  const hasOpenLoops = Array.isArray(obj.openLoops);
  const hasArchiveObservations = Array.isArray(obj.archiveObservations);
  const hasArchiveEpisodes = Array.isArray(obj.archiveEpisodes);

  if (
    !hasTimeContexts &&
    !hasOpenLoops &&
    !hasArchiveObservations &&
    !hasArchiveEpisodes
  ) {
    log.warn(
      "reducer output has no recognized top-level arrays — falling back to empty result",
    );
    return EMPTY_REDUCER_RESULT;
  }

  const timeContexts: TimeContextOp[] = [];
  if (hasTimeContexts) {
    for (const item of obj.timeContexts as unknown[]) {
      const validated = validateTimeContextOp(item);
      if (validated) timeContexts.push(validated);
    }
  }

  const openLoops: OpenLoopOp[] = [];
  if (hasOpenLoops) {
    for (const item of obj.openLoops as unknown[]) {
      const validated = validateOpenLoopOp(item);
      if (validated) openLoops.push(validated);
    }
  }

  const archiveObservations: ArchiveObservationCandidate[] = [];
  if (hasArchiveObservations) {
    for (const item of obj.archiveObservations as unknown[]) {
      const validated = validateArchiveObservation(item);
      if (validated) archiveObservations.push(validated);
    }
  }

  const archiveEpisodes: ArchiveEpisodeCandidate[] = [];
  if (hasArchiveEpisodes) {
    for (const item of obj.archiveEpisodes as unknown[]) {
      const validated = validateArchiveEpisode(item);
      if (validated) archiveEpisodes.push(validated);
    }
  }

  return { timeContexts, openLoops, archiveObservations, archiveEpisodes };
}
