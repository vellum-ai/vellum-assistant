/**
 * On-disk store for activation-checklist progress
 * (`<workspace>/data/activation-progress.json`).
 *
 * The checklist itself (task copy, icons, ordering) lives in the web
 * client; the daemon only records which task was launched into which
 * conversation and how far it got, so every client of one assistant sees
 * the same state. Task ids and list ids are therefore opaque strings,
 * constrained to {@link ACTIVATION_ID_PATTERN} so a client cannot turn a
 * JSON key into an unbounded blob.
 *
 * Reads are synchronous and degrade to the empty default: a missing or
 * corrupt file means "nothing started yet", which is the same state a
 * fresh assistant is in. Writes are atomic (temp file + rename) and
 * serialized through a single in-process promise chain so concurrent
 * route calls and turn hooks cannot interleave a read-modify-write.
 *
 * Every write that changes visible state publishes the
 * `activation:progress` sync tag so sibling clients refetch.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ACTIVATION_ID_PATTERN,
  type ActivationArtifact,
  ActivationArtifactSchema,
  type ActivationDismissKind,
  type ActivationProgress,
  ActivationProgressSchema,
  emptyActivationProgress,
} from "../api/responses/activation.js";
import { SYNC_TAGS } from "../daemon/message-types/sync.js";
import { BadRequestError } from "../runtime/routes/errors.js";
import { publishSyncInvalidation } from "../runtime/sync/sync-publisher.js";
import { getLogger } from "../util/logger.js";
import { getDataDir } from "../util/platform.js";

const log = getLogger("activation-progress-store");

/** Filename for the on-disk snapshot. Lives under the workspace data dir. */
export const ACTIVATION_PROGRESS_FILENAME = "activation-progress.json";

/**
 * Minimum interval between step-count invalidations for one task. Tool
 * calls arrive in bursts, and each one only moves a counter in a pill, so
 * both the disk write and the broadcast coalesce into one per window with
 * a trailing flush that persists the final count.
 */
export const ACTIVATION_STEP_BUMP_THROTTLE_MS = 2_000;

/** Live throttle window. Only {@link resetActivationStepThrottleForTesting} moves it. */
let stepThrottleMs: number = ACTIVATION_STEP_BUMP_THROTTLE_MS;

/** Upper bound on artifacts recorded per task, so a chatty turn cannot grow the file. */
const MAX_ARTIFACTS_PER_TASK = 10;

/**
 * Canonical path to the progress snapshot
 * (`<workspace>/data/activation-progress.json`).
 */
export function getActivationProgressPath(): string {
  return join(getDataDir(), ACTIVATION_PROGRESS_FILENAME);
}

/** Throw a 400 unless `value` is a well-formed activation identifier. */
function assertActivationId(value: string, label: string): void {
  if (!ACTIVATION_ID_PATTERN.test(value)) {
    throw new BadRequestError(
      `Invalid ${label}: must match ${ACTIVATION_ID_PATTERN.source}`,
    );
  }
}

/**
 * Read the progress snapshot. A missing file, unreadable file, or one that
 * fails schema validation all degrade to the empty default rather than
 * throwing: the checklist is an onboarding nicety, never a hard failure.
 */
export function readActivationProgress(): ActivationProgress {
  let raw: string;
  try {
    raw = readFileSync(getActivationProgressPath(), "utf-8");
  } catch {
    return emptyActivationProgress();
  }
  try {
    return ActivationProgressSchema.parse(JSON.parse(raw));
  } catch (err) {
    log.warn(
      { err, path: getActivationProgressPath() },
      "Unreadable activation-progress.json; treating as empty",
    );
    return emptyActivationProgress();
  }
}

function writeActivationProgress(progress: ActivationProgress): void {
  const path = getActivationProgressPath();
  mkdirSync(getDataDir(), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(progress, null, 2), "utf-8");
  renameSync(tmpPath, path);
}

// ---------------------------------------------------------------------------
// Serialized mutation
// ---------------------------------------------------------------------------

let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Run `mutate` against a freshly read snapshot, persisting and publishing
 * only when it reports a change. Every mutation queues behind the previous
 * one, so a route call and a turn hook can never read the same snapshot and
 * clobber each other.
 */
async function mutateActivationProgress(
  mutate: (progress: ActivationProgress) => boolean,
): Promise<ActivationProgress> {
  const run = async (): Promise<ActivationProgress> => {
    const progress = readActivationProgress();
    if (!mutate(progress)) {
      return progress;
    }
    try {
      writeActivationProgress(progress);
    } catch (err) {
      log.warn({ err }, "Failed to write activation-progress.json");
      return progress;
    }
    await publishSyncInvalidation([SYNC_TAGS.activationProgress]);
    return progress;
  };
  const next = writeChain.then(run, run);
  // Keep the chain alive even when a link rejects, so one failure cannot
  // strand every later mutation.
  writeChain = next.catch(() => {});
  return next;
}

/** Freeze the list on the first write that names one. */
function applyListId(progress: ActivationProgress, listId?: string): boolean {
  if (listId === undefined || progress.listId !== null) {
    return false;
  }
  assertActivationId(listId, "listId");
  progress.listId = listId;
  return true;
}

function findLinkedTaskId(
  progress: ActivationProgress,
  conversationId: string,
): string | null {
  for (const [taskId, task] of Object.entries(progress.tasks)) {
    if (task.conversationId === conversationId && task.status === "started") {
      return taskId;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Link a task to the conversation it was launched into.
 *
 * Idempotent: re-starting a task in the same conversation changes nothing.
 * A different conversation replaces the link (and restarts the counters)
 * only while the task is not `done`. A finished task keeps its record.
 */
export async function startActivationTask(params: {
  taskId: string;
  conversationId: string;
  listId?: string;
}): Promise<ActivationProgress> {
  const { taskId, conversationId, listId } = params;
  assertActivationId(taskId, "taskId");
  if (conversationId.trim().length === 0) {
    throw new BadRequestError("conversationId is required");
  }
  if (listId !== undefined) {
    assertActivationId(listId, "listId");
  }

  return mutateActivationProgress((progress) => {
    const listChanged = applyListId(progress, listId);
    const existing = progress.tasks[taskId];
    if (
      existing?.status === "done" ||
      existing?.conversationId === conversationId
    ) {
      return listChanged;
    }
    progress.tasks[taskId] = {
      status: "started",
      conversationId,
      startedAt: new Date().toISOString(),
      completedAt: null,
      stepCount: 0,
      artifacts: [],
    };
    return true;
  });
}

/**
 * Record that the welcome modal (`modal`) or the celebration modal
 * (`all-done`) was dismissed. The first dismissal timestamp is kept: the
 * field records that the surface was seen, so reopening it from the pill
 * and closing it again does not rewrite history.
 */
export async function dismissActivation(params: {
  kind: ActivationDismissKind;
  listId?: string;
}): Promise<ActivationProgress> {
  const { kind, listId } = params;
  if (listId !== undefined) {
    assertActivationId(listId, "listId");
  }

  return mutateActivationProgress((progress) => {
    let changed = applyListId(progress, listId);
    const field = kind === "modal" ? "modalDismissedAt" : "allDoneShownAt";
    if (progress[field] === null) {
      progress[field] = new Date().toISOString();
      changed = true;
    }
    return changed;
  });
}

// ---------------------------------------------------------------------------
// Step counting
// ---------------------------------------------------------------------------

/** Tool calls seen since the last flush, keyed by conversation. */
const pendingStepBumps = new Map<string, number>();
const stepBumpTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastStepFlushAt = new Map<string, number>();

async function flushStepBumps(conversationId: string): Promise<void> {
  const timer = stepBumpTimers.get(conversationId);
  if (timer) {
    clearTimeout(timer);
    stepBumpTimers.delete(conversationId);
  }
  const delta = pendingStepBumps.get(conversationId) ?? 0;
  pendingStepBumps.delete(conversationId);
  if (delta === 0) {
    return;
  }
  lastStepFlushAt.set(conversationId, Date.now());
  await mutateActivationProgress((progress) => {
    const taskId = findLinkedTaskId(progress, conversationId);
    if (!taskId) {
      return false;
    }
    const task = progress.tasks[taskId];
    task.stepCount = (task.stepCount ?? 0) + delta;
    return true;
  });
}

/**
 * Count one tool call against the task linked to this conversation.
 *
 * A no-op for conversations that no `started` task points at, so the hot
 * path costs one small read for every other conversation. Flushes are
 * throttled to one per {@link ACTIVATION_STEP_BUMP_THROTTLE_MS} per
 * conversation, with a trailing flush so the final count still lands.
 */
export async function bumpActivationStepCount(
  conversationId: string,
): Promise<void> {
  // A pending bump already proved the link, so a burst reads the file once.
  // `flushStepBumps` re-checks before writing, so a link that disappears
  // mid-burst degrades to a no-op flush.
  if (
    !pendingStepBumps.has(conversationId) &&
    !findLinkedTaskId(readActivationProgress(), conversationId)
  ) {
    return;
  }
  pendingStepBumps.set(
    conversationId,
    (pendingStepBumps.get(conversationId) ?? 0) + 1,
  );

  const now = Date.now();
  const lastFlush = lastStepFlushAt.get(conversationId) ?? 0;
  const elapsed = now - lastFlush;
  if (elapsed >= stepThrottleMs) {
    await flushStepBumps(conversationId);
    return;
  }
  if (stepBumpTimers.has(conversationId)) {
    return;
  }
  const timer = setTimeout(() => {
    void flushStepBumps(conversationId).catch(() => {});
  }, stepThrottleMs - elapsed);
  timer.unref?.();
  stepBumpTimers.set(conversationId, timer);
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

function normalizeArtifacts(
  artifacts: readonly ActivationArtifact[],
): ActivationArtifact[] {
  const seen = new Set<string>();
  const result: ActivationArtifact[] = [];
  for (const artifact of artifacts) {
    const parsed = ActivationArtifactSchema.safeParse(artifact);
    if (!parsed.success || parsed.data.workspacePath.length === 0) {
      continue;
    }
    if (seen.has(parsed.data.workspacePath)) {
      continue;
    }
    seen.add(parsed.data.workspacePath);
    result.push(parsed.data);
    if (result.length >= MAX_ARTIFACTS_PER_TASK) {
      break;
    }
  }
  return result;
}

/**
 * Mark the task linked to this conversation `done`.
 *
 * A no-op for unlinked conversations and idempotent for linked ones: a
 * second terminal turn in the same conversation finds no `started` task
 * and changes nothing. `stepCount` never moves backwards, so the number
 * the user watched climb is the number they end up with.
 */
export async function markActivationTurnComplete(params: {
  conversationId: string;
  toolCallCount: number;
  artifacts: readonly ActivationArtifact[];
}): Promise<void> {
  const { conversationId, toolCallCount, artifacts } = params;
  await flushStepBumps(conversationId);
  await mutateActivationProgress((progress) => {
    const taskId = findLinkedTaskId(progress, conversationId);
    if (!taskId) {
      return false;
    }
    const task = progress.tasks[taskId];
    task.status = "done";
    task.completedAt = new Date().toISOString();
    task.stepCount = Math.max(task.stepCount ?? 0, Math.max(0, toolCallCount));
    task.artifacts = normalizeArtifacts(artifacts);
    return true;
  });
}

/**
 * Drop the in-process step-bump throttle state, optionally shortening the
 * window. Test-only seam: production code lets the trailing timers run at
 * {@link ACTIVATION_STEP_BUMP_THROTTLE_MS}.
 */
export function resetActivationStepThrottleForTesting(
  overrideMs?: number,
): void {
  for (const timer of stepBumpTimers.values()) {
    clearTimeout(timer);
  }
  stepBumpTimers.clear();
  pendingStepBumps.clear();
  lastStepFlushAt.clear();
  stepThrottleMs = overrideMs ?? ACTIVATION_STEP_BUMP_THROTTLE_MS;
}
