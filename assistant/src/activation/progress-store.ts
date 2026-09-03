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
 * fresh assistant is in. A file stamped with a schema version this build
 * does not know is the one case that does not degrade to a rewrite: it is
 * served read-only so a rollback cannot erase the newer document, and a
 * write against it fails with a 409 rather than reporting a success that
 * never touched disk.
 * Writes are atomic (temp file + rename) and serialized twice over. A
 * single in-process promise chain keeps concurrent route calls and turn
 * hooks from interleaving a read-modify-write, and an exclusive lock file
 * beside the snapshot extends that to the daemon's sidecar workers, which
 * load this module against the same workspace and would otherwise read a
 * snapshot the daemon is about to replace. Serialization is never traded
 * away to make a write go through: a lock another process will not let go
 * of fails the mutation with a 503 rather than racing its rename. A write
 * that cannot land rejects, so a route never answers with state the next
 * read would contradict; the fire-and-forget turn hooks catch, retry within
 * their own bounds, and log.
 *
 * A conversation belongs to at most one task: {@link startActivationTask}
 * unlinks any other `started` task pointing at the same conversation, so
 * the step and completion lookups can resolve one record and never strand
 * another. Which conversations are linked is mirrored in memory
 * ({@link linkIndex}) so the per-tool-call hooks answer for the
 * overwhelmingly common unlinked conversation without reading the file.
 *
 * Every write that changes visible state publishes the
 * `activation:progress` sync tag so sibling clients refetch, carrying the
 * client that made it so that client can suppress its own echo.
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import {
  ACTIVATION_CONVERSATION_ID_MAX_LENGTH,
  ACTIVATION_ID_PATTERN,
  ACTIVATION_PROGRESS_VERSION,
  type ActivationArtifact,
  ActivationArtifactSchema,
  type ActivationDismissKind,
  type ActivationProgress,
  ActivationProgressSchema,
  ActivationTaskProgressSchema,
  emptyActivationProgress,
} from "../api/responses/activation.js";
import {
  BadRequestError,
  ConflictError,
  InternalError,
  ServiceUnavailableError,
} from "../runtime/routes/errors.js";
import { publishActivationProgressChanged } from "../runtime/sync/resource-sync-events.js";
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

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * A snapshot plus what the file said about itself. `readOnly` marks a
 * document written by a schema version this build does not understand: its
 * fields are read as far as they still parse, and nothing is written back.
 */
interface ActivationSnapshot {
  progress: ActivationProgress;
  readOnly: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read what a newer document still has in common with this schema, field by
 * field, so a client on an older build shows the progress it can understand
 * rather than an empty checklist.
 *
 * Every field this build knows is validated by the same schema the strict
 * read uses, and every task key by the same {@link ACTIVATION_ID_PATTERN}
 * the write path enforces: a newer document is still a document a client
 * renders, so it may not smuggle a value past the bounds an ordinary read
 * applies. Anything else is passed over rather than guessed at.
 */
function parseForwardCompatible(document: unknown): ActivationProgress {
  const progress = emptyActivationProgress();
  if (!isRecord(document)) {
    return progress;
  }
  const { listId, modalDismissedAt, allDoneShownAt } =
    ActivationProgressSchema.shape;
  const parsedListId = listId.safeParse(document.listId);
  if (parsedListId.success) {
    progress.listId = parsedListId.data;
  }
  const parsedModalDismissedAt = modalDismissedAt.safeParse(
    document.modalDismissedAt,
  );
  if (parsedModalDismissedAt.success) {
    progress.modalDismissedAt = parsedModalDismissedAt.data;
  }
  const parsedAllDoneShownAt = allDoneShownAt.safeParse(
    document.allDoneShownAt,
  );
  if (parsedAllDoneShownAt.success) {
    progress.allDoneShownAt = parsedAllDoneShownAt.data;
  }
  if (isRecord(document.tasks)) {
    for (const [taskId, task] of Object.entries(document.tasks)) {
      if (!ACTIVATION_ID_PATTERN.test(taskId)) {
        continue;
      }
      const parsed = ActivationTaskProgressSchema.safeParse(task);
      if (parsed.success) {
        progress.tasks[taskId] = parsed.data;
      }
    }
  }
  return progress;
}

function readActivationSnapshot(): ActivationSnapshot {
  const path = getActivationProgressPath();
  // Stamped before the bytes are read, so a write that lands between the two
  // leaves the index looking stale rather than fresh: the next miss sees a
  // changed stamp and re-reads.
  const stamp = progressFileStamp();
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return refreshLinkIndex(
      { progress: emptyActivationProgress(), readOnly: false },
      stamp,
    );
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (err) {
    log.warn(
      { err, path },
      "Unreadable activation-progress.json; treating as empty",
    );
    return refreshLinkIndex(
      { progress: emptyActivationProgress(), readOnly: false },
      stamp,
    );
  }

  // The version is read before the shape is, so a document this build cannot
  // parse is still recognized as one it must not overwrite.
  const version = isRecord(document) ? document.version : undefined;
  if (typeof version === "number" && version > ACTIVATION_PROGRESS_VERSION) {
    log.warn(
      { path, version, supported: ACTIVATION_PROGRESS_VERSION },
      "activation-progress.json was written by a newer build; serving it read-only",
    );
    return refreshLinkIndex(
      { progress: parseForwardCompatible(document), readOnly: true },
      stamp,
    );
  }

  const parsed = ActivationProgressSchema.safeParse(document);
  if (!parsed.success) {
    log.warn(
      { err: parsed.error, path },
      "Unreadable activation-progress.json; treating as empty",
    );
    return refreshLinkIndex(
      { progress: emptyActivationProgress(), readOnly: false },
      stamp,
    );
  }
  return refreshLinkIndex({ progress: parsed.data, readOnly: false }, stamp);
}

/**
 * Read the progress snapshot. A missing file, unreadable file, or one that
 * fails schema validation all degrade to the empty default rather than
 * throwing: the checklist is an onboarding nicety, never a hard failure.
 */
export function readActivationProgress(): ActivationProgress {
  return readActivationSnapshot().progress;
}

/** Writes the document atomically, replacing whatever was at the path. */
function writeActivationProgress(progress: ActivationProgress): void {
  const path = getActivationProgressPath();
  mkdirSync(getDataDir(), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(progress, null, 2), "utf-8");
    renameSync(tmpPath, path);
  } catch (err) {
    // A temp file left behind by a failed write is never picked up again
    // (the next attempt writes its own), so it would only accumulate.
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Linked-conversation index
// ---------------------------------------------------------------------------

/**
 * Conversation id → the `started` task it belongs to, for the conversations
 * one exists for at all.
 *
 * The step hook runs on every tool call in every conversation, so the
 * "nothing points at this conversation" answer has to be free: without this
 * index each of those calls pays a `readFileSync`, a `JSON.parse`, and a
 * schema validation for a snapshot it then discards. Consulting the index
 * costs one map lookup, and at worst one `statSync`.
 *
 * Within one process every read and every mutation rebuilds the index from
 * what it just saw, so the index cannot drift from its own writes. The file
 * has more than one writer though: the daemon, the schedule worker, and the
 * memory worker each load this module against the same workspace, so a link
 * the daemon records is invisible to a worker that already cached its
 * absence. `linkIndexStamp` closes that gap for the answer that would
 * otherwise be wrong forever. It records the file's size and mtime as of the
 * read the index was built from, and a *miss* is confirmed against a fresh
 * `statSync` before it is believed. A hit still costs one map lookup and no
 * syscall, and a miss costs one stat rather than a read, a parse, and a
 * schema validation. An index rebuilt from a mutation carries no stamp,
 * because nothing observable after the rename is provably that mutation's
 * bytes; the first miss after a write therefore re-reads once and stamps the
 * index from that read.
 *
 * `linkIndexPath` pins the index to the workspace it was built from: a
 * process that switches workspaces (tests do) falls back to a read rather
 * than answering from another workspace's links.
 */
let linkIndex: Map<string, string> | null = null;
let linkIndexPath: string | null = null;
let linkIndexStamp: string | null = null;

/**
 * Cheap identity of the progress file as it is on disk right now: its size
 * and modification time, or `absent` when there is no file. Two writes
 * inside one filesystem timestamp tick that also land on the same byte
 * length are indistinguishable, which costs a worker one stale miss until
 * the next write; every other rewrite changes the stamp.
 */
function progressFileStamp(): string {
  try {
    const stats = statSync(getActivationProgressPath());
    return `${stats.size}:${stats.mtimeMs}`;
  } catch {
    return "absent";
  }
}

/**
 * Rebuild the index from `snapshot`, filed under the stamp of the bytes that
 * snapshot came from, or under `null` when no stamp is provably tied to those
 * bytes. The caller supplies the stamp because only the caller knows which
 * bytes those were: a read stamps before it reads, and a write passes `null`
 * because any stat it takes after its rename may describe another writer's
 * file. A `null` stamp matches no stat, so the first miss against the index
 * re-reads once and files the result under a real stamp; hits answer from the
 * map with no syscall either way.
 */
function refreshLinkIndex(
  snapshot: ActivationSnapshot,
  stamp: string | null,
): ActivationSnapshot {
  const next = new Map<string, string>();
  for (const [taskId, task] of Object.entries(snapshot.progress.tasks)) {
    if (task.status === "started") {
      next.set(task.conversationId, taskId);
    }
  }
  linkIndex = next;
  linkIndexPath = getActivationProgressPath();
  linkIndexStamp = stamp;
  return snapshot;
}

/** Drop the index, so the next lookup rebuilds it from disk. */
function invalidateLinkIndex(): void {
  linkIndex = null;
  linkIndexPath = null;
  linkIndexStamp = null;
}

/**
 * The `started` task this conversation belongs to, or `null`, answered from
 * the in-memory index. Reads the file when the index is cold, and when the
 * index has no link for this conversation but the file has changed since the
 * index was built (another process may have written the link).
 */
function linkedTaskIdFor(conversationId: string): string | null {
  if (linkIndex === null || linkIndexPath !== getActivationProgressPath()) {
    readActivationSnapshot();
    return linkIndex?.get(conversationId) ?? null;
  }
  const linked = linkIndex?.get(conversationId);
  if (linked !== undefined) {
    return linked;
  }
  if (progressFileStamp() === linkIndexStamp) {
    return null;
  }
  readActivationSnapshot();
  return linkIndex?.get(conversationId) ?? null;
}

// ---------------------------------------------------------------------------
// Interprocess lock
// ---------------------------------------------------------------------------

/** Suffix of the lock file that guards a read-modify-write of the snapshot. */
const ACTIVATION_PROGRESS_LOCK_SUFFIX = ".lock";

/**
 * How long a mutation waits for another process to finish before it gives up
 * and fails. Every holder does one small read and one rename, so a wait this
 * long means the holder is wedged rather than busy.
 */
const LOCK_WAIT_TIMEOUT_MS = 2_000;

/** Live wait bound. Only {@link setActivationLockTimingForTesting} moves it. */
let lockWaitTimeoutMs: number = LOCK_WAIT_TIMEOUT_MS;

/** Pause between attempts while another process holds the lock. */
const LOCK_RETRY_DELAY_MS = 15;

/**
 * Age at which a lock is treated as abandoned. Generous next to the work a
 * holder does, so a slow filesystem is waited out rather than trampled, and
 * short enough that a process killed mid-mutation does not block its
 * successors for the life of the workspace.
 */
const LOCK_STALE_MS = 5_000;

/** Path of the lock file, beside the snapshot it guards. */
export function getActivationProgressLockPath(): string {
  return `${getActivationProgressPath()}${ACTIVATION_PROGRESS_LOCK_SUFFIX}`;
}

/** Whether a process id still names a live process. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM is a process this user may not signal, which is still a process.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * One attempt at the lock.
 *
 * `held` is the ordinary contended answer: another process created the file
 * first. `unavailable` is everything else (an unwritable or occupied data
 * directory), which the caller treats as "no lock to be had here" rather than
 * as contention: the write that follows reports the real failure, and
 * spinning for it would only delay that report.
 */
function tryAcquireProgressLock(
  lockPath: string,
): "acquired" | "held" | "unavailable" {
  try {
    mkdirSync(getDataDir(), { recursive: true });
  } catch {
    return "unavailable";
  }
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EEXIST"
      ? "held"
      : "unavailable";
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
  } catch {
    // The holder identity is an optimization for stale detection, not the
    // lock itself: an empty lock file still excludes every other writer, and
    // reads as abandoned once it ages out.
  } finally {
    closeSync(fd);
  }
  return "acquired";
}

/**
 * Whether the lock on disk belongs to a writer that is never coming back:
 * one whose process is gone, one older than {@link LOCK_STALE_MS}, or one
 * whose contents say nothing this build can check.
 *
 * A lock that has vanished by the time it is read is not stale, it is free,
 * and the next create attempt takes it.
 */
function progressLockIsStale(lockPath: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf-8");
  } catch {
    return false;
  }
  let holder: unknown;
  try {
    holder = JSON.parse(raw);
  } catch {
    return true;
  }
  if (!isRecord(holder)) {
    return true;
  }
  const { pid, at } = holder;
  if (typeof at !== "number" || Date.now() - at >= LOCK_STALE_MS) {
    return true;
  }
  return typeof pid === "number" && pid !== process.pid && !processIsAlive(pid);
}

/**
 * Take the lock for the whole read-modify-write below, so a sidecar worker
 * and the daemon cannot both read one snapshot and rename over each other's
 * update.
 *
 * Returns whether the lock is held, and only a caller holding it releases it.
 * `false` is the answer for a data directory that cannot hold a lock at all:
 * there is no other writer to exclude on a path nothing can be written to,
 * and the write that follows reports the real failure.
 *
 * A holder that will not let go is the other case, and it throws. Waiting out
 * {@link LOCK_WAIT_TIMEOUT_MS} and then writing anyway would read a snapshot
 * that holder is about to rename over and silently drop one of the two
 * updates, so the mutation fails with a 503 instead: the caller learns its
 * write did not land, which is the whole contract the routes and the hooks
 * are built on.
 */
async function acquireProgressLock(): Promise<boolean> {
  const lockPath = getActivationProgressLockPath();
  const deadline = Date.now() + lockWaitTimeoutMs;
  for (;;) {
    const attempt = tryAcquireProgressLock(lockPath);
    if (attempt === "acquired") {
      return true;
    }
    if (attempt === "unavailable") {
      return false;
    }
    if (progressLockIsStale(lockPath)) {
      // Whoever left this behind is gone. Clear it and contend for it again
      // on the next pass rather than assuming the removal was ours.
      rmSync(lockPath, { force: true });
    }
    if (Date.now() >= deadline) {
      log.warn(
        { lockPath },
        "Timed out waiting for the activation progress lock; refusing the write",
      );
      throw new ServiceUnavailableError(
        "Activation progress is being updated by another process; try again",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_DELAY_MS));
  }
}

function releaseProgressLock(): void {
  try {
    rmSync(getActivationProgressLockPath(), { force: true });
  } catch (err) {
    log.warn({ err }, "Failed to release the activation progress lock");
  }
}

// ---------------------------------------------------------------------------
// Serialized mutation
// ---------------------------------------------------------------------------

let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Run `mutate` against a freshly read snapshot, persisting and publishing
 * only when it reports a change. Every mutation queues behind the previous
 * one, so a route call and a turn hook can never read the same snapshot and
 * clobber each other, and the whole read-mutate-write transaction runs under
 * the interprocess lock so a sidecar worker cannot either.
 *
 * Rejects when the snapshot cannot be persisted, so a route answers 500
 * rather than echoing state that only ever existed in memory. A lock another
 * process holds past {@link LOCK_WAIT_TIMEOUT_MS} rejects with a 503, which
 * is the same promise kept a different way: the write is refused rather than
 * raced, and the client is told to try again. A snapshot a
 * newer build wrote rejects too, with a 409: the document is left byte for
 * byte alone, and the caller is told the write did not land rather than
 * being handed a snapshot that looks like it did. That distinction is
 * load-bearing for the client: it sends the task's prompt only once the
 * link is recorded, and a silent 200 here would start a conversation no
 * task points at.
 */
async function mutateActivationProgress(
  mutate: (progress: ActivationProgress) => boolean,
  originClientId?: string,
): Promise<ActivationProgress> {
  const run = async (): Promise<ActivationProgress> => {
    const locked = await acquireProgressLock();
    try {
      // Read inside the lock: a snapshot taken before it was held could
      // already be the version another process is renaming over.
      const snapshot = readActivationSnapshot();
      const { progress } = snapshot;
      if (snapshot.readOnly) {
        log.warn(
          { path: getActivationProgressPath() },
          "Refusing activation progress write: the stored document is from a newer build",
        );
        throw new ConflictError(
          "Activation progress was written by a newer version of this assistant and cannot be updated by this build",
        );
      }
      if (!mutate(progress)) {
        return progress;
      }
      try {
        writeActivationProgress(progress);
      } catch (err) {
        // The index was built from what was on disk before the mutation, and
        // the in-memory document has moved on from both. Drop it.
        invalidateLinkIndex();
        log.warn({ err }, "Failed to write activation-progress.json");
        throw new InternalError("Failed to persist activation progress");
      }
      refreshLinkIndex(snapshot, null);
      publishActivationProgressChanged(originClientId);
      return progress;
    } finally {
      if (locked) {
        releaseProgressLock();
      }
    }
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

/**
 * The `started` task this conversation belongs to, or `null`. At most one
 * exists: {@link startActivationTask} unlinks the others as it links.
 */
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

/**
 * Drop every `started` task other than `taskId` that points at this
 * conversation. Returns whether anything was dropped.
 *
 * The record is removed rather than kept with a dead link: a task whose
 * conversation now belongs to another task has no progress left to report,
 * and leaving it `started` is exactly the state the transition lookups
 * would ignore. A `done` task keeps its record; its history is finished.
 */
function unlinkOtherTasks(
  progress: ActivationProgress,
  conversationId: string,
  taskId: string,
): boolean {
  let unlinked = false;
  for (const [otherId, other] of Object.entries(progress.tasks)) {
    if (
      otherId !== taskId &&
      other.status === "started" &&
      other.conversationId === conversationId
    ) {
      delete progress.tasks[otherId];
      unlinked = true;
    }
  }
  return unlinked;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Link a task to the conversation it was launched into.
 *
 * Idempotent: re-starting a task in the same conversation changes nothing.
 * A different conversation replaces the link (and restarts the counters)
 * only while the task is not `done`. A finished task keeps its record, and
 * keeps its hands off the conversation: a task still running there owns it.
 *
 * A conversation carries one task at a time. Launching a second task into
 * a conversation another `started` task points at drops that stale record
 * in the same write, so the step and completion lookups never resolve one
 * task while silently ignoring another.
 */
export async function startActivationTask(params: {
  taskId: string;
  conversationId: string;
  listId?: string;
  originClientId?: string;
}): Promise<ActivationProgress> {
  const { taskId, conversationId, listId, originClientId } = params;
  assertActivationId(taskId, "taskId");
  if (conversationId.trim().length === 0) {
    throw new BadRequestError("conversationId is required");
  }
  if (conversationId.length > ACTIVATION_CONVERSATION_ID_MAX_LENGTH) {
    throw new BadRequestError(
      `conversationId must be at most ${ACTIVATION_CONVERSATION_ID_MAX_LENGTH} characters`,
    );
  }
  if (listId !== undefined) {
    assertActivationId(listId, "listId");
  }

  return mutateActivationProgress((progress) => {
    const listChanged = applyListId(progress, listId);
    const existing = progress.tasks[taskId];
    if (existing?.status === "done") {
      return listChanged;
    }
    const unlinked = unlinkOtherTasks(progress, conversationId, taskId);
    if (existing?.conversationId === conversationId) {
      return listChanged || unlinked;
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
  }, originClientId);
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
  originClientId?: string;
}): Promise<ActivationProgress> {
  const { kind, listId, originClientId } = params;
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
  }, originClientId);
}

// ---------------------------------------------------------------------------
// Deleted conversations
// ---------------------------------------------------------------------------

/**
 * Drop what the checklist recorded about conversations that no longer exist.
 *
 * A `started` task whose conversation is gone has nothing left to report and
 * nowhere left to send the user, so its record is removed: the row returns to
 * Todo and the task can be launched again.
 *
 * A `done` task keeps its record. The work it describes happened, and the
 * step count and artifacts on it are the user's history whether or not the
 * conversation survived. Only the dead link is cleared, the same thing the
 * home feed does to a "Go to Thread" target it can no longer open, so the
 * finished row stops offering to open a conversation that is not there.
 */
function forgetLinkedConversations(
  progress: ActivationProgress,
  matches: (conversationId: string) => boolean,
): boolean {
  let changed = false;
  for (const [taskId, task] of Object.entries(progress.tasks)) {
    if (!matches(task.conversationId)) {
      continue;
    }
    if (task.status === "started") {
      delete progress.tasks[taskId];
      changed = true;
    } else if (task.conversationId.length > 0) {
      task.conversationId = "";
      changed = true;
    }
  }
  return changed;
}

/**
 * Whether the checklist has ever written anything for this workspace. A
 * deletion in an assistant that never showed the checklist must not create
 * the snapshot (or its lock) just to find nothing to forget.
 */
function activationProgressFileExists(): boolean {
  return progressFileStamp() !== "absent";
}

/**
 * Release a deleted conversation from the checklist. See
 * {@link forgetLinkedConversations} for what survives.
 */
export async function forgetActivationConversation(
  conversationId: string,
): Promise<void> {
  if (conversationId.length === 0 || !activationProgressFileExists()) {
    return;
  }
  await mutateActivationProgress((progress) =>
    forgetLinkedConversations(progress, (id) => id === conversationId),
  );
}

/**
 * Release every conversation from the checklist, for the clear-all wipe that
 * removes all of them at once.
 */
export async function forgetAllActivationConversations(): Promise<void> {
  if (!activationProgressFileExists()) {
    return;
  }
  await mutateActivationProgress((progress) =>
    forgetLinkedConversations(progress, () => true),
  );
}

// ---------------------------------------------------------------------------
// Step counting
// ---------------------------------------------------------------------------

/**
 * Attempts a restored delta gets before the count is abandoned. A turn can
 * end without another tool call, so nothing else would drive the retry; the
 * bound is what keeps a permanently unwritable file from arming a timer per
 * window forever.
 */
const MAX_STEP_FLUSH_ATTEMPTS = 3;

/** Tool calls seen since the last flush, keyed by conversation. */
const pendingStepBumps = new Map<string, number>();
const stepBumpTimers = new Map<string, ReturnType<typeof setTimeout>>();
const lastStepFlushAt = new Map<string, number>();
/** Consecutive failed flushes per conversation, cleared by the first success. */
const stepFlushAttempts = new Map<string, number>();

function addPendingStepBumps(conversationId: string, delta: number): void {
  pendingStepBumps.set(
    conversationId,
    (pendingStepBumps.get(conversationId) ?? 0) + delta,
  );
}

/** Arm the trailing flush timer, unless one is already armed. */
function armStepFlushTimer(conversationId: string, delayMs: number): void {
  if (stepBumpTimers.has(conversationId)) {
    return;
  }
  const timer = setTimeout(() => {
    // The timer owns the only reference to this flush, so it swallows the
    // rejection the awaiting callers would otherwise have handled.
    void flushStepBumps(conversationId).catch(() => {});
  }, delayMs);
  timer.unref?.();
  stepBumpTimers.set(conversationId, timer);
}

/**
 * Re-arm a flush for a delta a failed write put back. Bounded: once a
 * conversation has burned its attempts the count is dropped, because a
 * completing turn re-establishes `stepCount` from its own tool-call total
 * anyway and an unbounded retry would outlive the conversation.
 */
function retryStepFlush(conversationId: string): void {
  const attempts = (stepFlushAttempts.get(conversationId) ?? 0) + 1;
  if (attempts >= MAX_STEP_FLUSH_ATTEMPTS) {
    log.warn(
      { conversationId, attempts },
      "Giving up on persisting activation step counts after repeated write failures",
    );
    pendingStepBumps.delete(conversationId);
    stepFlushAttempts.delete(conversationId);
    return;
  }
  stepFlushAttempts.set(conversationId, attempts);
  armStepFlushTimer(conversationId, stepThrottleMs);
}

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
  try {
    await mutateActivationProgress((progress) => {
      const taskId = findLinkedTaskId(progress, conversationId);
      if (!taskId) {
        return false;
      }
      const task = progress.tasks[taskId];
      task.stepCount = (task.stepCount ?? 0) + delta;
      return true;
    });
    stepFlushAttempts.delete(conversationId);
  } catch (err) {
    if (err instanceof ConflictError) {
      // The stored document belongs to a newer build, so no later flush can
      // land either. Drop the count rather than retrying a write this build
      // is not allowed to make.
      stepFlushAttempts.delete(conversationId);
      throw err;
    }
    // The write did not land, whether the file refused it or another process
    // held the lock past its wait, so the tool calls it carried are still
    // uncounted. Put them back (behind anything that arrived meanwhile) and
    // arm a bounded retry: a turn can end here, with no later tool call to
    // drive the flush.
    addPendingStepBumps(conversationId, delta);
    retryStepFlush(conversationId);
    throw err;
  }
}

/**
 * Count one tool call against the task linked to this conversation.
 *
 * A no-op for conversations that no `started` task points at, and free for
 * them: the link is answered from the in-memory index, so a conversation
 * outside the checklist never touches the progress file. Flushes are
 * throttled to one per {@link ACTIVATION_STEP_BUMP_THROTTLE_MS} per
 * conversation, with a trailing flush so the final count still lands.
 */
export async function bumpActivationStepCount(
  conversationId: string,
): Promise<void> {
  // A pending bump already proved the link, so a burst skips the lookup
  // entirely. `flushStepBumps` re-checks against the snapshot it writes,
  // so a link that disappears mid-burst degrades to a no-op flush.
  if (
    !pendingStepBumps.has(conversationId) &&
    !linkedTaskIdFor(conversationId)
  ) {
    return;
  }
  addPendingStepBumps(conversationId, 1);

  const now = Date.now();
  const lastFlush = lastStepFlushAt.get(conversationId) ?? 0;
  const elapsed = now - lastFlush;
  if (elapsed >= stepThrottleMs) {
    await flushStepBumps(conversationId);
    return;
  }
  armStepFlushTimer(conversationId, stepThrottleMs - elapsed);
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

/**
 * How long a completion waits before its single retry. Long enough for a
 * holder that was merely slow to finish or age out of
 * {@link LOCK_STALE_MS}, short enough that the row leaves Working while the
 * user is still watching it.
 */
const COMPLETION_RETRY_DELAY_MS = 1_000;

/** Live retry delay. Only {@link setActivationLockTimingForTesting} moves it. */
let completionRetryMs: number = COMPLETION_RETRY_DELAY_MS;

/** Armed completion retries, keyed by conversation. */
const completionRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Try one completion again, once, after {@link COMPLETION_RETRY_DELAY_MS}.
 *
 * Bounded on purpose: a second failure is a lock nothing here can break, and
 * the checklist row is worth one more attempt rather than a timer per
 * finished turn for the life of the process. The timer is unref'd so a
 * pending retry never holds the process open, and one conversation arms at
 * most one, so a second terminal turn cannot stack them.
 */
function armCompletionRetry(
  conversationId: string,
  complete: () => Promise<unknown>,
): void {
  if (completionRetryTimers.has(conversationId)) {
    return;
  }
  const timer = setTimeout(() => {
    completionRetryTimers.delete(conversationId);
    void complete().catch((err: unknown) => {
      log.warn(
        { err, conversationId },
        "Giving up on marking an activation task done: the progress file stayed locked",
      );
    });
  }, completionRetryMs);
  timer.unref?.();
  completionRetryTimers.set(conversationId, timer);
}

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
 * A terminal turn finishes the task unless it ended waiting on the user:
 * an open question card or an interactive surface still awaiting an action
 * means the assistant handed the turn back rather than delivering, so the
 * task stays `started` and the answer's turn finishes it. Everything else
 * completes, including a turn that answered entirely in prose with no tool
 * call and no attached file, which is a perfectly ordinary way to finish a
 * checklist task.
 *
 * The signal is structural, so a clarifying question the assistant asks in
 * plain prose rather than through a question card still reads as a
 * completed turn. That is a known v1 limitation: telling the two apart is a
 * judgement call, and the fix is an assistant-judged outcome at the turn
 * boundary rather than a heuristic here.
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
  endedAwaitingUser: boolean;
}): Promise<void> {
  const { conversationId, toolCallCount, artifacts, endedAwaitingUser } =
    params;
  if (
    !pendingStepBumps.has(conversationId) &&
    !linkedTaskIdFor(conversationId)
  ) {
    return;
  }
  // A failed flush must not strand the row on Working. The completion
  // mutation re-establishes `stepCount` from `toolCallCount` via `Math.max`,
  // and the flush has already re-queued its delta for a bounded retry.
  await flushStepBumps(conversationId).catch(() => {});
  if (endedAwaitingUser) {
    return;
  }
  const complete = (): Promise<ActivationProgress> =>
    mutateActivationProgress((progress) => {
      const taskId = findLinkedTaskId(progress, conversationId);
      if (!taskId) {
        return false;
      }
      const task = progress.tasks[taskId];
      task.status = "done";
      task.completedAt = new Date().toISOString();
      task.stepCount = Math.max(
        task.stepCount ?? 0,
        Math.max(0, toolCallCount),
      );
      task.artifacts = normalizeArtifacts(artifacts);
      return true;
    });
  try {
    await complete();
  } catch (err) {
    if (!(err instanceof ServiceUnavailableError)) {
      throw err;
    }
    // Another process held the lock for the whole wait. Nothing else will
    // drive this task to `done`: the turn is over, so there is no later tool
    // call and no later terminal turn to try again from.
    log.warn(
      { err, conversationId },
      "Activation progress was busy when a turn finished; retrying the completion once",
    );
    armCompletionRetry(conversationId, complete);
  }
}

/**
 * Drop the in-process step-bump throttle state, any armed completion retry,
 * and the linked-conversation index, optionally shortening the throttle
 * window. Test-only seam:
 * production code lets the trailing timers run at
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
  stepFlushAttempts.clear();
  for (const timer of completionRetryTimers.values()) {
    clearTimeout(timer);
  }
  completionRetryTimers.clear();
  invalidateLinkIndex();
  stepThrottleMs = overrideMs ?? ACTIVATION_STEP_BUMP_THROTTLE_MS;
}

/**
 * Shorten how long a mutation waits for a lock another process holds, and how
 * long a busy completion waits before its one retry, so a test can exercise
 * the contended paths in milliseconds. Test-only seam: production waits
 * {@link LOCK_WAIT_TIMEOUT_MS} and {@link COMPLETION_RETRY_DELAY_MS}.
 */
export function setActivationLockTimingForTesting(overrides?: {
  waitMs?: number;
  retryMs?: number;
}): void {
  lockWaitTimeoutMs = overrides?.waitMs ?? LOCK_WAIT_TIMEOUT_MS;
  completionRetryMs = overrides?.retryMs ?? COMPLETION_RETRY_DELAY_MS;
}
