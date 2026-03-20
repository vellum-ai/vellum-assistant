/**
 * Simplified memory reducer — provider-backed conversation turn processor.
 *
 * This module owns:
 *   1. ReducerPromptInput — structured input for the provider call
 *   2. runReducer — send the transcript span to the LLM and return a typed result
 *   3. parseReducerOutput — raw string -> validated ReducerResult
 *   4. Fallback to EMPTY_REDUCER_RESULT on unparseable output (parse failures only)
 *
 * The reducer is intentionally side-effect-free: it never writes to the
 * database. Callers are responsible for applying the returned ReducerResult.
 */

import {
  createTimeout,
  extractText,
  getConfiguredProvider,
} from "../providers/provider-send-message.js";
import { getLogger } from "../util/logger.js";
import { classifyError } from "./job-utils.js";
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

/** Timeout for the reducer provider call (ms). */
const REDUCER_TIMEOUT_MS = 30_000;

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
  /** Current time as epoch ms — injected for deterministic tests. */
  nowMs: number;
  /** Memory scope identifier (e.g. assistant instance ID). */
  scopeId: string;
}

// ── System prompt ─────────────────────────────────────────────────────

/**
 * Build the reducer system prompt. Extracted as a named function so tests can
 * assert on prompt content without coupling to string literals.
 */
export function buildReducerSystemPrompt(): string {
  return [
    "You are a memory reducer for a personal assistant. Your job is to analyze",
    "a span of new conversation messages and produce structured JSON output that",
    "captures important information for the assistant's long-term memory.",
    "",
    "You output a single JSON object with four optional arrays:",
    "",
    "1. `timeContexts` — time-bounded situational context (e.g. 'user traveling next week').",
    "   Each entry has: action ('create'|'update'|'resolve'), and fields depending on the action.",
    "   - create: summary (string), source (string), activeFrom (epoch ms), activeUntil (epoch ms)",
    "   - update: id (string), and at least one of: summary, activeFrom, activeUntil",
    "   - resolve: id (string)",
    "",
    "2. `openLoops` — unresolved items to track (e.g. 'waiting for Bob's reply').",
    "   Each entry has: action ('create'|'update'|'resolve'), and fields depending on the action.",
    "   - create: summary (string), source (string), optional dueAt (epoch ms)",
    "   - update: id (string), and at least one of: summary, dueAt",
    "   - resolve: id (string), status ('resolved'|'expired')",
    "",
    "3. `archiveObservations` — factual statements extracted from the conversation.",
    "   Each entry has: content (string), role (string), optional modality (string), optional source (string)",
    "",
    "4. `archiveEpisodes` — coherent narrative summaries of interaction spans.",
    "   Each entry has: title (string), summary (string), optional source (string)",
    "",
    "Rules:",
    "- Output ONLY valid JSON. No markdown, no explanation, no wrapping.",
    "- Omit arrays that would be empty rather than including empty arrays.",
    "- For updates and resolves, reference existing IDs from the provided context.",
    "- Be selective: only extract genuinely important or actionable information.",
    "- Timestamps are in epoch milliseconds.",
    "- If there is nothing meaningful to extract, output: {}",
  ].join("\n");
}

/**
 * Build the user-message content for the reducer prompt from the structured input.
 */
export function buildReducerUserMessage(input: ReducerPromptInput): string {
  const parts: string[] = [];

  parts.push(
    `Current time: ${new Date(input.nowMs).toISOString()} (${input.nowMs}ms)`,
  );
  parts.push(`Conversation: ${input.conversationId}`);
  parts.push(`Scope: ${input.scopeId}`);
  parts.push("");

  // Existing state the model can reference for updates/resolves
  if (input.existingTimeContexts.length > 0) {
    parts.push("## Active time contexts");
    for (const tc of input.existingTimeContexts) {
      parts.push(`- [${tc.id}] ${tc.summary}`);
    }
    parts.push("");
  }

  if (input.existingOpenLoops.length > 0) {
    parts.push("## Active open loops");
    for (const ol of input.existingOpenLoops) {
      parts.push(`- [${ol.id}] (${ol.status}) ${ol.summary}`);
    }
    parts.push("");
  }

  // The unreduced transcript span
  parts.push("## New messages to process");
  for (const msg of input.newMessages) {
    parts.push(`[${msg.role}]: ${msg.content}`);
  }

  return parts.join("\n");
}

// ── Provider-backed reducer call ──────────────────────────────────────

/**
 * Run the memory reducer against a transcript span.
 *
 * Sends the unreduced messages, active time contexts, active open loops,
 * current time, and scope metadata to the configured LLM provider. Parses
 * the response into a typed {@link ReducerResult}.
 *
 * This function is **side-effect-free**: it never writes to the database.
 * The caller is responsible for applying the returned result.
 *
 * Returns {@link EMPTY_REDUCER_RESULT} when:
 * - No provider is configured/available
 * - The provider call fails with a transient error (timeouts, 5xx, rate limits)
 * - The call is aborted via the provided signal
 * - The model output is unparseable
 *
 * @throws Re-throws permanent provider errors (4xx client errors such as
 *         400 "prompt too long", 401, 403) so callers can handle them
 *         (e.g. force-advancing the dirty tail to break retry loops).
 *
 * @param input  Structured reducer input
 * @param signal Optional external abort signal
 */
export async function runReducer(
  input: ReducerPromptInput,
  signal?: AbortSignal,
): Promise<ReducerResult> {
  const provider = await getConfiguredProvider();
  if (!provider) {
    log.warn(
      "No provider available for memory reducer — returning empty result",
    );
    return EMPTY_REDUCER_RESULT;
  }

  const systemPrompt = buildReducerSystemPrompt();
  const userText = buildReducerUserMessage(input);

  const { signal: timeoutSignal, cleanup } = createTimeout(REDUCER_TIMEOUT_MS);
  const combinedSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  try {
    const response = await provider.sendMessage(
      [{ role: "user", content: [{ type: "text", text: userText }] }],
      undefined,
      systemPrompt,
      {
        signal: combinedSignal,
        config: {
          modelIntent: "latency-optimized" as const,
          max_tokens: 4096,
        },
      },
    );

    const rawText = extractText(response);
    if (!rawText) {
      log.warn("Reducer provider returned empty text — returning empty result");
      return EMPTY_REDUCER_RESULT;
    }

    return parseReducerOutput(rawText);
  } catch (err) {
    if (combinedSignal.aborted) {
      log.warn("Memory reducer provider call timed out or was aborted");
      return EMPTY_REDUCER_RESULT;
    }

    // Permanent provider errors (400 "prompt too long", 401, 403, etc.)
    // must not be silently swallowed — re-throw so callers can handle them
    // (e.g. force-advancing the dirty tail to break retry loops).
    const category = classifyError(err);
    if (category === "fatal") {
      log.error(
        { err },
        "Memory reducer provider call failed with permanent error",
      );
      throw err;
    }

    log.warn({ err }, "Memory reducer provider call failed (transient)");
    return EMPTY_REDUCER_RESULT;
  } finally {
    cleanup();
  }
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
 * On any structural error (non-JSON, not a JSON object) the function returns
 * {@link EMPTY_REDUCER_RESULT} rather than throwing — callers use identity
 * comparison (`=== EMPTY_REDUCER_RESULT`) to detect true parse failures and
 * skip checkpoint advancement.
 *
 * A valid JSON object with no recognized top-level arrays (e.g. `{}`) is
 * treated as a **valid-but-empty** response — the model simply had nothing
 * to extract. In this case a normal `ReducerResult` with all empty arrays
 * is returned so that callers advance the checkpoint and clear the dirty
 * tail, avoiding an infinite retry loop.
 *
 * Individual invalid operations within an otherwise valid structure are
 * silently dropped to preserve the rest of the result.
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

  // Check which top-level array keys are present
  const hasTimeContexts = Array.isArray(obj.timeContexts);
  const hasOpenLoops = Array.isArray(obj.openLoops);
  const hasArchiveObservations = Array.isArray(obj.archiveObservations);
  const hasArchiveEpisodes = Array.isArray(obj.archiveEpisodes);

  // A valid JSON object with no recognized arrays (e.g. `{}`) means the
  // model had nothing to extract — return a normal (non-sentinel) empty
  // result so the checkpoint advances.
  if (
    !hasTimeContexts &&
    !hasOpenLoops &&
    !hasArchiveObservations &&
    !hasArchiveEpisodes
  ) {
    log.debug(
      "reducer output is valid JSON with no extractions — advancing with empty result",
    );
    return {
      timeContexts: [],
      openLoops: [],
      archiveObservations: [],
      archiveEpisodes: [],
    };
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
