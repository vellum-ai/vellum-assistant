/**
 * Long-term storage retention for ambient camera frames.
 *
 * The counterpart to `conversation-sight-frames.ts`, which bounds what a frame
 * costs the model. That pass rewrites the copy of the history a turn is about
 * to send and never touches what is stored. This one bounds what a frame costs
 * the disk: a call samples a frame every few seconds for as long as the camera
 * is up, and each one is a full-resolution image that outlives the call.
 *
 * Aged frames are re-encoded to a thumbnail in place, so the transcript block
 * keeps resolving and the row, its links, and its message content are left
 * exactly as they were. Deleting a conversation is still the only thing that
 * removes a frame; this sweep never deletes a row.
 *
 * The bytes are the only thing that changes. In particular the persist-time
 * `sizeBytes` / `width` / `height` hints on the message's own `workspace_ref`
 * block are left alone: they are message content, which the retention pass
 * above reads, and after a sweep they merely overstate the block, which costs
 * the token estimator nothing but conservatism. The provider path re-reads and
 * re-sniffs the stored bytes on every send (`providers/media-resolve.ts`), so
 * what the model receives is always what is actually on disk.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { getConfig } from "../config/loader.js";
import {
  MAX_SIGHT_SWEEP_AFTER_DAYS,
  MIN_SIGHT_SWEEP_AFTER_DAYS,
  SWEEP_SIGHT_FRAMES_AFTER_DAYS,
} from "../config/schemas/sight.js";
import {
  attachmentShrinkRefusal,
  deleteSweepLeftover,
  getAttachmentContent,
  reclaimAttachmentSweepBackup,
  type ReclaimBackupResult,
  selectSightFrameSweepCandidates,
  shrinkAttachmentBytes,
  type SightFrameSweepCursor,
  SWEEP_BACKUP_SUFFIX,
  SWEEP_TEMP_SUFFIX,
} from "../persistence/attachments-store.js";
import { convertImageToJpeg } from "../util/image-conversion.js";
import { getLogger } from "../util/logger.js";
import { getConversationsDir, getWorkspaceDir } from "../util/platform.js";
import { getDbMigrationReadiness } from "./daemon-readiness.js";

const log = getLogger("sight-frame-storage-sweep");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Longest side a swept frame keeps: enough to recognize the room, not to read it. */
const SWEPT_MAX_DIMENSION_PX = 512;

/** JPEG quality for a swept frame. Below transport quality; nothing re-reads these for detail. */
const SWEPT_JPEG_QUALITY = 60;

/**
 * Size at or under which a frame counts as already swept.
 *
 * This is the sweep's idempotence signal, and it is a stored column rather than
 * a new marker because the alternatives are worse: pixel dimensions would mean
 * decoding every candidate on every tick just to ask whether to skip it, and a
 * marker on the message would mean writing the metadata this sweep is otherwise
 * careful never to touch. It doubles as the query's bounding predicate, so a
 * pass over an install with nothing left to shrink matches no rows at all.
 *
 * Comfortably above what {@link SWEPT_MAX_DIMENSION_PX} at
 * {@link SWEPT_JPEG_QUALITY} produces (tens of KB), so a swept frame lands well
 * clear of the threshold rather than just under it.
 */
const SWEPT_MAX_BYTES = 128 * 1024;

/** Rows one candidate query asks for. A pass walks as many pages as its bounds allow. */
const SWEEP_PAGE_SIZE = 200;

/**
 * Re-encodes a pass will attempt before stopping.
 *
 * The bound is counted in ENCODES rather than rows because that is where the
 * cost is. A refusal the store can decide from the row alone (a shared file, a
 * file it does not own) costs two point queries, so a pass steps over any number
 * of those to reach work it can actually do; producing a thumbnail costs real
 * CPU, and a frame that comes out no smaller costs it for nothing.
 *
 * 200 frames an hour is far more than a camera generates, so the bound only ever
 * binds on a backlog, which is exactly when a pass should stop and let the next
 * one continue.
 */
const MAX_ENCODE_ATTEMPTS_PER_PASS = 200;

/**
 * Rows a pass will READ before stopping, whatever it managed to encode.
 *
 * Charged against what the queries actually touched, not against the candidates
 * they yielded, and the page is built so those are the same thing: it visits
 * exactly the rows it returns, so nothing a pass does is invisible here. A range
 * full of attachments that qualify for nothing (wrong kind, already small, no
 * sight tag) still costs page slots and lookups, and counting only candidates
 * would leave all of it free.
 *
 * The cursor below is what makes stopping safe: the next pass resumes where this
 * one ran out rather than starting over.
 */
const MAX_ROWS_READ_PER_PASS = 5_000;

/**
 * Where the last pass stopped, so the next one resumes instead of re-examining
 * rows it already refused. Reset to the head once a scan reaches the end of the
 * candidate set, so newly aged frames and rows whose circumstances changed get
 * looked at again.
 *
 * In memory on purpose. A durable marker would be a schema addition to survive
 * a restart, and what a restart actually costs is one pass that re-examines the
 * refusals at the head before advancing past them again, which is a handful of
 * queries once per boot.
 */
let sweepCursor: SightFrameSweepCursor | null = null;

/**
 * Conversation directories a pass checks for leftover sweep files.
 *
 * The reclaim cannot be driven off the candidate set, which is the whole
 * problem: a row whose update landed no longer selects, so the pass that shrank
 * it is the last one that will ever look at it, and a backup left by a process
 * that died before the unlink would sit there forever. Directories are the only
 * place a leftover can be found without knowing which row it belonged to, and
 * they find the ones whose row is gone entirely, which no row-driven probe can.
 *
 * Bounded and staged rather than exhaustive. A full walk is a `readdir` per
 * conversation, and what it is looking for only appears when a process dies
 * inside a window a few microseconds wide, so 40 directories an hour clears a
 * few thousand conversations in a couple of days and costs nothing meanwhile.
 * The staging cursor is in memory, on the same terms as the row cursor above.
 */
const MAX_BACKUP_DIRS_PER_PASS = 40;

let backupScanCursor: string | null = null;

/**
 * The sorted conversation directory names the current cycle is working through,
 * enumerated once when the cycle starts rather than on every pass.
 *
 * Listing the conversations directory is O(all conversations), so doing it each
 * pass would leave the advertised bound covering only the child scans while
 * discovery stayed unbounded. Held across the passes of one cycle, the cost is
 * one O(N) listing per full cycle and O(maxDirs) per pass.
 *
 * Two trades, both cheap here. Staleness: a conversation created mid-cycle is
 * not scanned until the cursor wraps and the list is rebuilt, which for files a
 * crash left behind is of no consequence, and a fresh conversation has had no
 * time to leave any. Memory: one string per conversation, bounded by the size of
 * the workspace, released and rebuilt at each wrap.
 *
 * A streaming `opendir` walk would avoid the list entirely, but the cursor
 * depends on a stable total order to resume from a name, and directory
 * iteration order is filesystem-defined rather than sorted, so streaming would
 * need its own ordering pass and give back what it saved.
 */
let backupScanDirNames: string[] | null = null;

/** How many times the conversations directory has been enumerated, for tests. */
let backupScanEnumerations = 0;

/**
 * How often the sweep runs. The window it enforces is measured in days, so an
 * hourly cadence is far finer than the guarantee needs; it is what bounds the
 * cost of the pass, whose candidate query has no index to ride (neither
 * `attachments.created_at` nor `messages.metadata` carries one) and therefore
 * scans a table each time.
 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Delay before the first pass. A desktop assistant is restarted often enough
 * that waiting a full interval could mean never sweeping at all, and startup is
 * already busy, so the first pass runs shortly after boot instead.
 */
const FIRST_SWEEP_DELAY_MS = 60_000;

let firstSweepTimer: ReturnType<typeof setTimeout> | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;
let sweepInProgress = false;

/**
 * The workspace's `sight.sweepAfterDays`, clamped to
 * [{@link MIN_SIGHT_SWEEP_AFTER_DAYS}, {@link MAX_SIGHT_SWEEP_AFTER_DAYS}].
 *
 * Clamped at read rather than rejected by the schema, matching
 * `resolveSightKeepLatestFrames`: an out-of-range window states an intent the
 * guardrail can honor part of the way, while failing validation would silently
 * fall back to a default the config never asked for.
 */
export function resolveSightSweepAfterDays(): number {
  const configured = getConfig().sight.sweepAfterDays;
  if (!Number.isFinite(configured)) {
    return SWEEP_SIGHT_FRAMES_AFTER_DAYS;
  }
  return Math.min(
    MAX_SIGHT_SWEEP_AFTER_DAYS,
    Math.max(MIN_SIGHT_SWEEP_AFTER_DAYS, Math.trunc(configured)),
  );
}

export interface SightFrameSweepResult {
  /** Frames whose stored bytes were replaced with a thumbnail. */
  shrunk: number;
  /** Freed bytes, counted as stored size before minus stored size after. */
  freedBytes: number;
  /** Candidates left alone: shared or foreign file, unreadable, or no smaller. */
  skipped: number;
  /** Candidates this pass looked at, refusals included. */
  examined: number;
  /**
   * Rows this pass's queries read, which is what the row budget is charged
   * against. Larger than {@link examined} whenever the prefilter admitted an
   * attachment no linked message actually tags.
   */
  rowsRead: number;
  /** What the directory scan did with the sweep files a crash left behind. */
  leftovers: SweepLeftoverTally;
}

export interface SweepLeftoverTally {
  /** Files removed as debris. */
  deleted: number;
  /** Backups renamed over a base file a crash left missing. */
  restored: number;
  /** Files left alone: a row still needs them, or one claims them outright. */
  skipped: number;
}

function emptyResult(): SightFrameSweepResult {
  return {
    shrunk: 0,
    freedBytes: 0,
    skipped: 0,
    examined: 0,
    rowsRead: 0,
    leftovers: { deleted: 0, restored: 0, skipped: 0 },
  };
}

export interface SightFrameSweepBounds {
  maxEncodeAttempts?: number;
  maxRowsRead?: number;
  maxBackupDirs?: number;
  pageSize?: number;
}

/**
 * Shrink aged camera frames, walking the candidate set from where the last pass
 * stopped until it runs out of rows or spends this pass's bounds.
 *
 * Never throws: a sweep that cannot run is a sweep that runs next hour.
 *
 * The bounds are parameters only so tests can make a pass stop early. Production
 * callers take the defaults.
 */
export async function sweepAgedSightFrames(
  bounds: SightFrameSweepBounds = {},
): Promise<SightFrameSweepResult> {
  if (!getDbMigrationReadiness().ready) {
    return emptyResult();
  }
  const maxEncodeAttempts =
    bounds.maxEncodeAttempts ?? MAX_ENCODE_ATTEMPTS_PER_PASS;
  const maxRowsRead = bounds.maxRowsRead ?? MAX_ROWS_READ_PER_PASS;

  const createdBefore = Date.now() - resolveSightSweepAfterDays() * MS_PER_DAY;
  const result = emptyResult();
  let cursor = sweepCursor;
  let encodeAttempts = 0;

  while (encodeAttempts < maxEncodeAttempts) {
    let page;
    try {
      page = selectSightFrameSweepCandidates({
        createdBefore,
        largerThanBytes: SWEPT_MAX_BYTES,
        limit: bounds.pageSize ?? SWEEP_PAGE_SIZE,
        after: cursor,
      });
    } catch (err) {
      log.warn({ err }, "Could not read aged camera frames");
      break;
    }
    result.rowsRead += page.rowsRead;

    let spentOnThisPage = false;
    for (const candidate of page.candidates) {
      result.examined += 1;
      // Ask before encoding. A row the store will refuse whatever it is handed
      // costs a query here and nothing more, which is what lets a pass walk past
      // a wall of them to the frames behind.
      const refusal = attachmentShrinkRefusal(candidate.id);
      if (refusal) {
        result.skipped += 1;
        log.debug(
          { attachmentId: candidate.id, outcome: refusal },
          "Left an aged camera frame alone",
        );
      } else {
        encodeAttempts += 1;
        try {
          const shrunkBytes = await shrinkOneFrame(candidate.id);
          if (shrunkBytes === null) {
            result.skipped += 1;
          } else {
            result.shrunk += 1;
            result.freedBytes += candidate.sizeBytes - shrunkBytes;
          }
        } catch (err) {
          result.skipped += 1;
          log.warn(
            { err, attachmentId: candidate.id },
            "Could not shrink an aged camera frame",
          );
        }
      }
      // Per candidate, not per page: a pass that stops on its bound part way
      // through has to resume on the next candidate, and a cursor holding the
      // page's last row would skip everything between.
      cursor = { createdAt: candidate.createdAt, id: candidate.id };
      if (encodeAttempts >= maxEncodeAttempts) {
        spentOnThisPage = true;
        break;
      }
    }
    if (spentOnThisPage) {
      break;
    }

    // The whole page was consumed, so step past its tail too: attachments the
    // metadata prefilter admitted and the tag check rejected are not candidates
    // and would otherwise be re-read on every pass.
    cursor = page.nextCursor ?? cursor;
    if (!page.hasMore) {
      // End of the candidate set. Start the next pass at the head so newly aged
      // frames, and rows whose circumstances changed, are seen again.
      cursor = null;
      break;
    }
    // Charged against rows READ, so a page that yielded no candidates still
    // spends the budget it cost. The cursor already names the last attachment
    // this page examined, so the next pass resumes behind it rather than paying
    // for the same near-misses again.
    if (result.rowsRead >= maxRowsRead) {
      break;
    }
  }

  sweepCursor = cursor;
  result.leftovers = reclaimSweepLeftovers(
    bounds.maxBackupDirs ?? MAX_BACKUP_DIRS_PER_PASS,
  );
  if (
    result.shrunk > 0 ||
    result.leftovers.deleted > 0 ||
    result.leftovers.restored > 0
  ) {
    log.info(result, "Shrank aged camera frames to thumbnail scale");
  }
  return result;
}

/**
 * Re-encode one frame and store the result, returning its new byte length, or
 * null when the frame was left exactly as it was.
 */
async function shrinkOneFrame(attachmentId: string): Promise<number | null> {
  const bytes = getAttachmentContent(attachmentId);
  if (!bytes) {
    return null;
  }
  // The same converter attachment ingress and transport optimization use, so
  // there is one encoder in the process and a swept frame is a JPEG every
  // client and provider already reads.
  const thumbnail = await convertImageToJpeg(bytes, {
    maxDimensionPx: SWEPT_MAX_DIMENSION_PX,
    quality: SWEPT_JPEG_QUALITY,
  });
  if (!thumbnail) {
    return null;
  }

  const outcome = shrinkAttachmentBytes(attachmentId, thumbnail, "image/jpeg");
  if (outcome !== "shrunk") {
    log.debug({ attachmentId, outcome }, "Left an aged camera frame alone");
    return null;
  }
  return thumbnail.length;
}

/**
 * Deal with the sweep files a killed process left behind, across a bounded slice
 * of the store's own attachment directories.
 *
 * The staging directory is checked every pass, being one directory; conversation
 * directories are taken `maxDirs` at a time, resuming by name from where the
 * last pass stopped and wrapping when the list runs out. Names are stable, so a
 * conversation created or deleted between passes cannot make the scan skip its
 * neighbours.
 *
 * What happens to a file is never decided by its name. The suffixes are derived
 * from an attachment's own path, not reserved, so a file the user picked can
 * carry one; every deletion goes through the store, which refuses any path a row
 * claims as its canonical bytes.
 *
 * Never throws. Returns what it deleted, restored, and left alone.
 */
function reclaimSweepLeftovers(maxDirs: number): SweepLeftoverTally {
  const tally: SweepLeftoverTally = { deleted: 0, restored: 0, skipped: 0 };
  reclaimLeftoversIn(join(getWorkspaceDir(), "data", "attachments"), tally);

  const conversationsDir = getConversationsDir();
  // A null cursor means the last cycle finished, so this pass starts a new one
  // and re-enumerates. That is also what picks up conversations created since.
  if (backupScanCursor === null || backupScanDirNames === null) {
    backupScanEnumerations += 1;
    try {
      backupScanDirNames = readdirSync(conversationsDir).sort();
    } catch {
      backupScanDirNames = [];
    }
  }
  const dirNames = backupScanDirNames;
  const resumeAfter = backupScanCursor;
  const resumeAt =
    resumeAfter === null ? 0 : dirNames.findIndex((name) => name > resumeAfter);
  if (resumeAt === -1) {
    backupScanCursor = null;
    return tally;
  }

  const slice = dirNames.slice(resumeAt, resumeAt + maxDirs);
  for (const name of slice) {
    reclaimLeftoversIn(join(conversationsDir, name, "attachments"), tally);
  }
  backupScanCursor =
    resumeAt + maxDirs >= dirNames.length
      ? null
      : (slice[slice.length - 1] ?? null);
  return tally;
}

/** One directory's leftovers. Never throws; a directory that is not there has none. */
function reclaimLeftoversIn(dir: string, tally: SweepLeftoverTally): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  // Backups first. One of them may put a missing base file back, and a temp
  // beside that base is only debris once the base it was going to replace is
  // there to compare it against.
  for (const entry of entries) {
    if (!entry.endsWith(SWEEP_BACKUP_SUFFIX)) {
      continue;
    }
    recordLeftoverOutcome(
      reclaimAttachmentSweepBackup(join(dir, entry)),
      tally,
    );
  }

  // A temp is a replacement that never reached its rename, so nothing wants it,
  // and this never runs while a shrink is in flight. The store still refuses to
  // unlink one that is some row's canonical file.
  for (const entry of entries) {
    if (!entry.endsWith(SWEEP_TEMP_SUFFIX)) {
      continue;
    }
    recordLeftoverOutcome(deleteSweepLeftover(join(dir, entry)), tally);
  }
}

function recordLeftoverOutcome(
  outcome: ReclaimBackupResult,
  tally: SweepLeftoverTally,
): void {
  if (outcome === "deleted") {
    tally.deleted += 1;
  } else if (outcome === "restored") {
    tally.restored += 1;
  } else if (outcome === "kept") {
    tally.skipped += 1;
  }
}

/** The pass cursor, for tests that assert a pass resumed rather than restarted. */
export function getSightFrameSweepCursorForTest(): SightFrameSweepCursor | null {
  return sweepCursor;
}

/** Send the next pass back to the head of the candidate set and the directory scan. */
export function resetSightFrameSweepCursorForTest(): void {
  sweepCursor = null;
  backupScanCursor = null;
  backupScanDirNames = null;
  backupScanEnumerations = 0;
}

/**
 * How many times the conversations directory has been listed, for tests that
 * assert discovery costs one listing per cycle rather than one per pass.
 */
export function getSightFrameSweepDirEnumerationsForTest(): number {
  return backupScanEnumerations;
}

/** Where the directory scan stopped, for tests that assert a cycle wrapped. */
export function getSightFrameSweepBackupCursorForTest(): string | null {
  return backupScanCursor;
}

/** Start the periodic sweep. Idempotent. */
export function startSightFrameStorageSweep(): void {
  if (sweepTimer || firstSweepTimer) {
    return;
  }
  firstSweepTimer = setTimeout(() => {
    firstSweepTimer = null;
    void runSweepPass();
  }, FIRST_SWEEP_DELAY_MS);
  sweepTimer = setInterval(() => {
    void runSweepPass();
  }, SWEEP_INTERVAL_MS);
}

/** Stop the periodic sweep. Used in tests and shutdown. */
export function stopSightFrameStorageSweep(): void {
  if (firstSweepTimer) {
    clearTimeout(firstSweepTimer);
    firstSweepTimer = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  sweepInProgress = false;
}

/** One pass, skipped while the previous one is still re-encoding. */
async function runSweepPass(): Promise<void> {
  if (sweepInProgress) {
    return;
  }
  sweepInProgress = true;
  try {
    await sweepAgedSightFrames();
  } finally {
    sweepInProgress = false;
  }
}
